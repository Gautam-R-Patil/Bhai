// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.

// ── Bhai Memory page (renderer) ─────────────
// What Bhai knows about the owner: a list (the default), a graph, and a weekly
// review of new facts. Mounts on first visit to the Memory tab; data comes
// read-only through window.bhai.studio.*, and every change goes back through it.
//
// Theme: colours resolve through the CSS custom properties in styles.css, so the
// light/dark switch recolours the graph without re-rendering it.

(() => {
    if (typeof window === "undefined") return;
    if (window.MemoryStudio) return;

    const KIND_LABEL = {
        you: "You",
        memory: "Memory",
        entity: "Person or thing",
        trait: "Trait",
        episode: "Episode",
        emotion: "Emotion",
        goal: "Goal",
        task_learning: "Learning",
        world_model: "World",
        self_state: "Self-state",
    };

    const CATEGORY_LABEL = {
        fact: "Facts",
        preference: "Preferences",
        person: "People",
        note: "Notes",
        task: "Tasks",
        research: "Research",
        session_summary: "Conversation summaries",
        bhai_did: "Things Bhai did",
        general: "General",
    };

    const SOURCE_LABEL = {
        user: "You told Bhai",
        tool: "Bhai saw it while working",
        reflection: "Bhai worked it out",
    };

    // Which graph node kinds each tab shows.
    const TAB_KINDS = {
        all: ["memory", "entity", "episode", "trait"],
        memory: ["memory"],
        entity: ["entity"],
        trait: ["trait"],
    };
    const ADVANCED_KINDS = new Set(["goal", "task_learning", "world_model", "self_state"]);
    // Bhai's own notes; the grouped list puts what it knows about the owner first.
    const BHAI_OWN = new Set(["research", "session_summary", "bhai_did"]);
    const GROUP_PREVIEW = 5; // rows per group on the grouped list
    const UNDO_MS = 6000; // a forget waits this long so Undo can take it back
    const FORGET_REASON = "forgotten in Memory";

    const state = {
        mounted: false,
        view: "list", // "list" | "graph"
        kind: "all", // tab: all | memory | entity | trait
        category: null, // one memory category, opened from "Show all"
        query: "",
        items: new Map(), // id → row shown in the list or review
        listExtra: { offset: 0, total: 0 }, // paging for a flat list
        stats: null,
        graph: null,
        graphAll: false, // graph: all time instead of the last 90 days
        advanced: false,
        simulation: null,
        svg: null,
        gRoot: null,
        gEdges: null,
        gNodes: null,
        gLabels: null,
        zoom: null,
        zoomK: 1,
        tooltip: null,
        selectedId: null,
        hidden: new Set(), // forgotten, waiting out the undo window
        pending: null, // { id, run, timer }
        review: [], // new facts to review, the current one first
        reviewTotal: 0,
        reviewOpen: false,
        searchTimer: null,
        themeObserver: null,
        palette: {},
    };

    const studio = () => window.bhai.studio;

    function $(id) {
        return document.getElementById(id);
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

    function _toast(msg) {
        if (typeof window.showToast === "function") window.showToast(msg);
    }

    // SQLite datetime('now') is UTC with no zone marker; read it as UTC.
    function _timeMs(ts) {
        if (!ts) return NaN;
        const s = String(ts);
        return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`).getTime();
    }

    function _timeAgo(ts) {
        const t = _timeMs(ts);
        if (!Number.isFinite(t)) return "";
        const s = Math.floor((Date.now() - t) / 1000);
        if (s < 60) return "just now";
        if (s < 3600) return `${Math.floor(s / 60)}m ago`;
        if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
        if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
        return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    }

    function _plural(n, word) {
        const many = word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`;
        return `${n.toLocaleString()} ${n === 1 ? word : many}`;
    }

    function _catLabel(cat) {
        const c = cat || "general";
        if (CATEGORY_LABEL[c]) return CATEGORY_LABEL[c];
        const words = c.replace(/_/g, " ");
        return words[0].toUpperCase() + words.slice(1);
    }

    function _sourceLabel(source) {
        if (!source) return "";
        if (source.startsWith("import")) return "Imported";
        return SOURCE_LABEL[source] || source.replace(/_/g, " ");
    }

    function _kindOf(nodeId) {
        const colon = nodeId.indexOf(":");
        return colon < 0 ? nodeId : nodeId.slice(0, colon);
    }

    function _idTail(nodeId) {
        const colon = nodeId.indexOf(":");
        return colon < 0 ? nodeId : nodeId.slice(colon + 1);
    }

    function _kindFromNamespace(prefix) {
        return (
            {
                you: "you",
                mem: "memory",
                cat: "memory",
                ent: "entity",
                epi: "episode",
                trait: "trait",
                emo: "emotion",
                goal: "goal",
                world: "world_model",
                self: "self_state",
            }[prefix] || "memory"
        );
    }

    function isNumericNs(ns) {
        return ns === "mem" || ns === "ent" || ns === "goal";
    }

    // The grey line under a row.
    function _metaFor(item) {
        if (item.kind === "entity") return _catLabel(item.category);
        if (item.kind === "trait") return `Trait · ${Math.round((item.confidence || 0) * 100)}% sure`;
        return [item.pinned ? "Pinned" : "", _sourceLabel(item.source), _timeAgo(item.createdAt)]
            .filter(Boolean)
            .join(" · ");
    }

    // ── Header line ─────────────

    async function _loadSummary() {
        const el = $("studioSummary");
        try {
            const [s, r] = await Promise.all([studio().stats(), studio().review()]);
            if (s?.success) state.stats = s.stats;
            if (!state.reviewOpen) state.review = r?.success ? r.items : []; // an open review keeps its own queue
        } catch {
            /* keeps the last numbers */
        }
        if (!el) return;
        const st = state.stats;
        if (!st) {
            el.textContent = "Bhai is still getting to know you.";
            return;
        }
        const total = st.memories + st.entities + st.traits;
        el.innerHTML = total
            ? `Bhai knows ${_plural(total, "thing")} about you.`
            : "Bhai is still getting to know you. Chat with Bhai, or import what another AI knows.";
        if (state.review.length) {
            el.innerHTML += ` <button type="button" class="studio-link" data-review>${state.review.length} new this week — review</button>`;
        }
    }

    // ── List ─────────────

    function _rowHtml(item) {
        const selected = item.id === state.selectedId;
        return `<li><button type="button" class="studio-row" data-id="${_escapeHtml(item.id)}" aria-pressed="${selected}">
            <span class="studio-row-text">${_escapeHtml(item.text)}</span>
            <span class="studio-row-meta">${_escapeHtml(_metaFor(item))}</span>
        </button></li>`;
    }

    function _groupHtml(title, items, total, moreAttr) {
        const shown = items.filter((i) => !state.hidden.has(i.id));
        if (!shown.length) return "";
        const more =
            total > shown.length && moreAttr
                ? `<button type="button" class="studio-link" ${moreAttr}>Show all ${total.toLocaleString()}</button>`
                : "";
        return `<div class="studio-group">
            <h3>${_escapeHtml(title)}</h3>
            <ul>${shown.map(_rowHtml).join("")}</ul>
            ${more}
        </div>`;
    }

    function _remember(items) {
        for (const it of items) state.items.set(it.id, it);
        return items;
    }

    async function _loadList() {
        const list = $("studioList");
        if (!list) return;
        let html = "";
        try {
            if (state.query) {
                const res = await studio().find(state.query);
                if (!res?.success) throw new Error(res?.error || "Search failed");
                const items = _remember(res.items).filter((i) => state.kind === "all" || i.kind === state.kind);
                const note = res.byMeaning ? "" : " · matched by words while Bhai isn't running";
                html = items.length
                    ? `<div class="studio-group"><h3>${_plural(items.length, "result")}${note}</h3><ul>${items
                          .filter((i) => !state.hidden.has(i.id))
                          .map(_rowHtml)
                          .join("")}</ul></div>`
                    : `<p class="studio-empty">Nothing matches “${_escapeHtml(state.query)}”.</p>`;
            } else if (state.category || state.kind === "entity" || state.kind === "trait") {
                const opts = state.category ? { kind: "memory", category: state.category } : { kind: state.kind };
                const res = await studio().list({ ...opts, limit: 100, offset: 0 });
                if (!res?.success) throw new Error(res?.error || "Couldn't load");
                state.listExtra = { opts, offset: res.items.length, total: res.total, items: _remember(res.items) };
                html = _flatListHtml();
            } else {
                const wantPeople = state.kind === "all";
                const [mem, ent, tr, st] = await Promise.all([
                    studio().list({ kind: "memory", limit: 400 }),
                    wantPeople ? studio().list({ kind: "entity", limit: GROUP_PREVIEW }) : null,
                    wantPeople ? studio().list({ kind: "trait", limit: GROUP_PREVIEW }) : null,
                    studio().stats(),
                ]);
                if (!mem?.success) throw new Error(mem?.error || "Couldn't load");
                if (st?.success) state.stats = st.stats;
                const counts = state.stats?.categories || {};
                const byCat = new Map();
                for (const it of _remember(mem.items)) {
                    if (!byCat.has(it.category)) byCat.set(it.category, []);
                    byCat.get(it.category).push(it);
                }
                const cats = [...byCat.keys()].sort(
                    (a, b) => BHAI_OWN.has(a) - BHAI_OWN.has(b) || (counts[b] || 0) - (counts[a] || 0),
                );
                const groups = cats.map((c) =>
                    _groupHtml(
                        _catLabel(c),
                        byCat.get(c).slice(0, GROUP_PREVIEW),
                        counts[c] || byCat.get(c).length,
                        `data-category="${_escapeHtml(c)}"`,
                    ),
                );
                if (ent?.success)
                    groups.push(
                        _groupHtml("People and things", _remember(ent.items), ent.total, 'data-kind-link="entity"'),
                    );
                if (tr?.success)
                    groups.push(_groupHtml("Traits", _remember(tr.items), tr.total, 'data-kind-link="trait"'));
                html =
                    groups.join("") ||
                    '<p class="studio-empty">Nothing here yet. As you chat, what Bhai learns about you shows up here.</p>';
            }
        } catch (err) {
            html = `<p class="studio-empty">${_escapeHtml(err.message)}</p>`;
        }
        list.innerHTML = html;
    }

    function _flatListHtml() {
        const x = state.listExtra;
        const title = state.category
            ? _catLabel(state.category)
            : state.kind === "entity"
              ? "People and things"
              : "Traits";
        const back = state.category ? '<button type="button" class="studio-link" data-back-all>← All</button>' : "";
        const more = x.total > x.offset ? `<button type="button" class="studio-link" data-more>Show more</button>` : "";
        const rows = x.items.filter((i) => !state.hidden.has(i.id));
        return `${back}<div class="studio-group">
            <h3>${_escapeHtml(title)} · ${x.total.toLocaleString()}</h3>
            ${rows.length ? `<ul>${rows.map(_rowHtml).join("")}</ul>` : '<p class="studio-empty">Nothing here yet.</p>'}
            ${more}
        </div>`;
    }

    async function _loadMore() {
        const x = state.listExtra;
        const res = await studio().list({ ...x.opts, limit: 100, offset: x.offset });
        if (!res?.success) return _toast(`Couldn't load more: ${res?.error || "unknown"}`);
        x.items.push(..._remember(res.items));
        x.offset += res.items.length;
        x.total = res.total;
        $("studioList").innerHTML = _flatListHtml();
    }

    function _onListClick(e) {
        const row = e.target.closest(".studio-row");
        if (row) return void _select(row.getAttribute("data-id"));
        const t = e.target.closest("button");
        if (!t) return;
        if (t.hasAttribute("data-category")) {
            state.category = t.getAttribute("data-category");
            _setTab("memory", true);
        } else if (t.hasAttribute("data-kind-link")) {
            _setTab(t.getAttribute("data-kind-link"));
        } else if (t.hasAttribute("data-back-all")) {
            state.category = null;
            _setTab("all");
        } else if (t.hasAttribute("data-more")) {
            _loadMore();
        }
    }

    function _setTab(kind, keepCategory) {
        state.kind = kind;
        if (!keepCategory) state.category = null;
        document.querySelectorAll("#studioTabs [data-kind]").forEach((b) => {
            b.setAttribute("aria-pressed", String(b.getAttribute("data-kind") === kind));
        });
        _reload();
    }

    function _setView(view) {
        state.view = view;
        document.querySelectorAll("#studioViews [data-view]").forEach((b) => {
            b.setAttribute("aria-pressed", String(b.getAttribute("data-view") === view));
        });
        $("studioList").hidden = view !== "list";
        $("studioGraphWrap").hidden = view !== "graph";
        if (view === "graph") _startGraph();
        else if (state.simulation) state.simulation.stop();
        _reload();
    }

    // Reload whatever is on screen.
    async function _reload() {
        if (state.view === "list") await _loadList();
        else await _loadGraphView();
    }

    async function refresh() {
        await Promise.all([_reload(), _loadSummary()]);
        if (state.selectedId && !_nodeFor(state.selectedId)) _select(null);
    }

    // ── Detail ─────────────

    // What we know about a node before asking the database: from the list, else the graph.
    function _nodeFor(id) {
        const item = state.items.get(id);
        if (item) return item;
        const n = state.graph?.nodes.find((g) => g.id === id);
        if (!n) return null;
        return {
            id: n.id,
            kind: n.kind,
            text: n.fullText || n.label,
            createdAt: n.createdAt,
            category: n.category,
            importance: n.importance,
            pinned: !!n.pinned,
            count: n.meta?.count,
        };
    }

    async function _select(id) {
        state.selectedId = id;
        document.querySelectorAll("#studioList .studio-row").forEach((r) => {
            r.setAttribute("aria-pressed", String(r.getAttribute("data-id") === id));
        });
        _highlightAdjacency(id);
        const detail = $("studioDetail");
        if (!detail) return;
        const node = id && _nodeFor(id);
        if (!node) {
            detail.setAttribute("data-open", "false");
            detail.innerHTML = "";
            return;
        }
        detail.setAttribute("data-open", "true");
        detail.innerHTML = _detailHtml(node, null, null);

        const ns = _kindOf(id);
        const tail = _idTail(id);
        const kind = _kindFromNamespace(ns);
        const key = isNumericNs(ns) ? Number(tail) : tail;
        let extra = null;
        let conns = null;
        try {
            if (ns === "you") {
                const r = await studio().you();
                if (r?.success) extra = r.you;
            } else if (ns === "cat") {
                conns = _anchorMembers(id);
            } else if (ns !== "world" && ns !== "self") {
                const [r, c] = await Promise.all([
                    studio().getNode(kind, key),
                    studio()
                        .connections(kind, key)
                        .catch(() => null),
                ]);
                if (r?.success) extra = r.node;
                if (c?.success)
                    conns = c.connections.map((x) => ({ ...x, id: typeof x.id === "number" ? `ent:${x.id}` : x.id }));
            }
        } catch {
            /* the first render stays */
        }
        if (state.selectedId !== id) return; // another row was picked meanwhile
        detail.innerHTML = _detailHtml(node, extra, conns);
    }

    function _detailHtml(node, extra, conns) {
        const ns = _kindOf(node.id);
        const facts = [];
        let text = node.text || "Untitled";
        let kindLine = KIND_LABEL[node.kind] || node.kind;
        if (ns === "mem") {
            if (extra?.content) text = extra.content;
            kindLine = `Memory · ${_catLabel(extra?.category || node.category)}`;
            const from = [_sourceLabel(extra?.source || node.source), _timeAgo(extra?.created_at || node.createdAt)]
                .filter(Boolean)
                .join(" · ");
            if (from) facts.push(["From", _escapeHtml(from)]);
            const imp = extra?.importance ?? node.importance;
            if (typeof imp === "number") facts.push(["Importance", `${Math.round(imp)} of 10`]);
            const tags = extra?.tags
                ? String(extra.tags)
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean)
                : [];
            if (tags.length) facts.push(["Tags", _escapeHtml(tags.join(", "))]);
        } else if (ns === "trait") {
            if (extra?.confidence != null || node.confidence != null) {
                facts.push(["How sure", `${Math.round((extra?.confidence ?? node.confidence) * 100)}%`]);
            }
        } else if (ns === "ent") {
            kindLine = `Person or thing · ${_catLabel(extra?.type || node.category)}`;
        } else if (ns === "cat") {
            kindLine = "Group";
            text = _catLabel(node.category);
            if (node.count) facts.push(["Holds", _plural(node.count, "memory")]);
        } else if (ns === "you" && extra) {
            text = extra.name || "You";
            const traits = (extra.topTraits || []).slice(0, 3).map((t) => t.key.replace(/_/g, " "));
            if (traits.length) facts.push(["Known for", _escapeHtml(traits.join(", "))]);
        } else if (ns === "epi" && extra?.description) {
            text = extra.description;
        }
        if (conns?.length) {
            const links = conns
                .slice(0, 8)
                .map(
                    (c) =>
                        `<button type="button" class="studio-link" data-goto="${_escapeHtml(String(c.id))}">${_escapeHtml(c.name || c.id)}</button>`,
                );
            facts.push(["Related", links.join(", ")]);
        }

        let actions = "";
        if (ns === "mem") {
            const pinned = !!(extra ? extra.pinned : node.pinned);
            actions = `
                <button type="button" class="btn btn-primary btn-sm" data-act="edit">Edit</button>
                <button type="button" class="btn btn-secondary btn-sm" data-act="pin" aria-pressed="${pinned}">${pinned ? "Unpin" : "Pin"}</button>
                <button type="button" class="btn btn-sm studio-danger" data-act="forget">Forget</button>`;
        } else if (ns === "trait" || ns === "ent") {
            actions = '<button type="button" class="btn btn-sm studio-danger" data-act="forget">Forget</button>';
        } else if (ns === "cat") {
            actions =
                '<button type="button" class="btn btn-secondary btn-sm" data-act="open-group">Show in list</button>';
        }

        return `
            <div class="studio-detail-head">
                <span>${_escapeHtml(kindLine)}</span>
                <button type="button" class="studio-icon-btn" data-act="close" aria-label="Close">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>
            </div>
            <p class="studio-detail-text">${_escapeHtml(text)}</p>
            ${facts.length ? `<dl class="studio-detail-facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>` : ""}
            ${actions ? `<div class="studio-detail-actions">${actions}</div>` : ""}
            <form class="studio-edit-form" data-edit-form hidden></form>
        `;
    }

    function _onDetailClick(e) {
        const t = e.target.closest("button");
        if (!t) return;
        const id = state.selectedId;
        const node = id && _nodeFor(id);
        if (t.hasAttribute("data-goto")) return void _select(t.getAttribute("data-goto"));
        const act = t.getAttribute("data-act");
        if (act === "close") _select(null);
        else if (!node) return;
        else if (act === "edit") _openEditForm(node);
        else if (act === "pin") _togglePin(node, t.getAttribute("aria-pressed") !== "true");
        else if (act === "forget") _forget(node);
        else if (act === "open-group") {
            state.category = node.category;
            _setView("list");
            _setTab("memory", true);
        }
    }

    async function _togglePin(node, next) {
        try {
            const res = await studio().pinMemory(Number(_idTail(node.id)), next);
            if (!res?.success) return _toast(`Pin failed: ${res?.error || "unknown"}`);
            await refresh();
            await _select(node.id);
        } catch (err) {
            _toast(`Pin failed: ${err.message}`);
        }
    }

    async function _openEditForm(node) {
        const form = $("studioDetail")?.querySelector("[data-edit-form]");
        if (!form) return;
        const r = await studio()
            .getNode("memory", Number(_idTail(node.id)))
            .catch(() => null);
        const row = r?.success ? r.node : {};
        const importance = Math.round(row.importance ?? node.importance ?? 5);
        form.hidden = false;
        form.innerHTML = `
            <textarea class="clean-input" data-edit-content aria-label="Memory" rows="4">${_escapeHtml(row.content || node.text || "")}</textarea>
            <label class="studio-edit-row">Importance <span data-imp>${importance}</span> of 10
                <input type="range" min="1" max="10" step="1" value="${importance}" data-edit-importance>
            </label>
            <div class="studio-detail-actions">
                <button type="submit" class="btn btn-primary btn-sm">Save</button>
                <button type="button" class="btn btn-secondary btn-sm" data-edit-cancel>Cancel</button>
            </div>
        `;
        const area = form.querySelector("[data-edit-content]");
        const slider = form.querySelector("[data-edit-importance]");
        slider.addEventListener("input", () => {
            form.querySelector("[data-imp]").textContent = slider.value;
        });
        form.querySelector("[data-edit-cancel]").addEventListener("click", () => {
            form.hidden = true;
            form.innerHTML = "";
        });
        area.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                form.requestSubmit();
            }
        });
        form.onsubmit = async (e) => {
            e.preventDefault();
            const content = area.value.trim();
            if (!content) return area.focus();
            const res = await studio()
                .updateMemory(Number(_idTail(node.id)), { content, importance: Number(slider.value) })
                .catch((err) => ({ error: err.message }));
            if (!res?.success) return _toast(`Couldn't save: ${res?.error || "unknown"}`);
            await refresh();
            await _select(node.id);
        };
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
    }

    // ── Forget, with a few seconds to undo ─────────────

    function _forgetCall(id) {
        const ns = _kindOf(id);
        const tail = _idTail(id);
        if (ns === "mem") return () => studio().forgetMemory(Number(tail), FORGET_REASON);
        if (ns === "trait") return () => studio().forgetTrait(tail, FORGET_REASON);
        if (ns === "ent") return () => studio().forgetEntity(Number(tail), FORGET_REASON, true);
        return null;
    }

    function _forget(node) {
        const run = _forgetCall(node.id);
        if (!run) return;
        _flushPending(); // an earlier forget goes through now
        state.hidden.add(node.id);
        state.pending = { id: node.id, run, timer: setTimeout(_flushPending, UNDO_MS) };
        if (state.selectedId === node.id) _select(null);
        _hideOnScreen();
        const text = (node.text || "").length > 60 ? `${node.text.slice(0, 59)}…` : node.text || "it";
        _showUndo(`Forgot “${text}”`);
    }

    async function _flushPending() {
        const p = state.pending;
        if (!p) return;
        state.pending = null;
        clearTimeout(p.timer);
        _hideUndo();
        let res;
        try {
            res = await p.run();
        } catch (err) {
            res = { success: false, error: err.message };
        }
        state.hidden.delete(p.id);
        if (!res?.success) _toast(`Couldn't forget it: ${res?.error || "unknown"}`);
        if (state.mounted) refresh();
    }

    function _undo() {
        const p = state.pending;
        if (!p) return;
        state.pending = null;
        clearTimeout(p.timer);
        state.hidden.delete(p.id);
        _hideUndo();
        _hideOnScreen();
        if (state.reviewOpen) {
            const item = state.items.get(p.id);
            if (item) {
                state.review.unshift(item);
                _renderReview();
            }
        } else _reload();
    }

    function _hideOnScreen() {
        document.querySelectorAll("#studioList .studio-row").forEach((r) => {
            r.closest("li").hidden = state.hidden.has(r.getAttribute("data-id"));
        });
        if (state.gNodes) {
            state.gNodes.selectAll("g.studio-graph-node").classed("gone", (d) => state.hidden.has(d.id));
            state.gLabels.selectAll("text").classed("gone", (d) => state.hidden.has(d.id));
        }
    }

    function _showUndo(msg) {
        const t = $("studioToast");
        if (!t) return;
        t.innerHTML = `<span>${_escapeHtml(msg)}</span><button type="button" class="studio-link" data-undo>Undo</button>`;
        t.hidden = false;
    }

    function _hideUndo() {
        const t = $("studioToast");
        if (t) t.hidden = true;
    }

    // ── Weekly review ─────────────

    function _openReview() {
        state.reviewOpen = true;
        state.reviewTotal = state.review.length;
        _remember(state.review);
        _select(null);
        $("studioMain").hidden = true;
        $("studioReview").hidden = false;
        _renderReview();
    }

    function _closeReview() {
        state.reviewOpen = false;
        $("studioMain").hidden = false;
        $("studioReview").hidden = true;
        refresh();
    }

    function _renderReview(fixing) {
        const wrap = $("studioReview");
        if (!wrap) return;
        const item = state.review[0];
        const back = '<button type="button" class="studio-link" data-review-back>← Memory</button>';
        if (!item) {
            wrap.innerHTML = `${back}<div class="studio-review-card"><p class="studio-review-text">All caught up.</p>
                <p class="studio-review-meta">New things Bhai learns about you will show up here.</p></div>`;
            wrap.querySelector("[data-review-back]").focus();
            return;
        }
        wrap.innerHTML = `${back}
            <div class="studio-review-card">
                <p class="studio-review-meta">New this week · ${state.reviewTotal - state.review.length + 1} of ${state.reviewTotal}</p>
                ${
                    fixing
                        ? `<label class="studio-review-fix">What's right?<textarea class="clean-input" rows="3" data-fix>${_escapeHtml(item.text)}</textarea></label>`
                        : `<p class="studio-review-text">${_escapeHtml(item.text)}</p>`
                }
                <p class="studio-review-meta">${_escapeHtml(_metaFor(item))}</p>
                <div class="studio-detail-actions">
                    ${
                        fixing
                            ? `<button type="button" class="btn btn-primary" data-review="save">Save</button>
                           <button type="button" class="btn btn-secondary" data-review="cancel">Cancel</button>`
                            : `<button type="button" class="btn btn-primary" data-review="keep">Keep</button>
                           <button type="button" class="btn btn-secondary" data-review="fix">Fix</button>
                           <button type="button" class="btn studio-danger" data-review="forget">Forget</button>
                           <span class="studio-spacer"></span>
                           <button type="button" class="studio-link" data-review="keep-rest">Keep the rest</button>`
                    }
                </div>
            </div>`;
        const focus = wrap.querySelector(fixing ? "[data-fix]" : '[data-review="keep"]');
        focus?.focus();
    }

    async function _onReviewClick(e) {
        const t = e.target.closest("button");
        if (!t) return;
        if (t.hasAttribute("data-review-back")) return _closeReview();
        const item = state.review[0];
        const act = t.getAttribute("data-review");
        if (!item || !act) return;
        const id = Number(_idTail(item.id));
        const next = () => {
            state.review.shift();
            _renderReview();
        };
        if (act === "fix") return _renderReview(true);
        if (act === "cancel") return _renderReview();
        t.disabled = true;
        let res = { success: true };
        if (act === "keep") res = await studio().markReviewed([id]);
        else if (act === "save") {
            const content = $("studioReview").querySelector("[data-fix]").value.trim();
            if (!content) {
                t.disabled = false;
                return;
            }
            res = await studio().updateMemory(id, { content });
            if (res?.success) res = await studio().markReviewed([id]);
        } else if (act === "forget") {
            _forget(item);
            return next();
        } else if (act === "keep-rest") {
            res = await studio().markReviewed(state.review.map((i) => Number(_idTail(i.id))));
            if (res?.success) {
                state.review.length = 0;
                return _renderReview();
            }
        }
        if (!res?.success) {
            t.disabled = false;
            return _toast(`Couldn't save: ${res?.error || "unknown"}`);
        }
        next();
    }

    // ── Import from another AI ─────────────
    // Step 1: pick the app, copy the export prompt into it, paste its answer
    // (or choose an export file). Step 2: review the facts Bhai pulled out.
    // Step 3: save the checked ones. Extraction/saving run in the bot.
    const IMPORT_CAP = 300; // the bot saves at most this many per import (memory-import.ts MAX_SAVE)
    function _openImportModal() {
        if (document.querySelector(".studio-import")) return; // already open
        const opener = document.activeElement;
        const backdrop = document.createElement("div");
        backdrop.className = "studio-modal-backdrop";
        backdrop.innerHTML = `
            <div class="studio-modal studio-import" role="dialog" aria-modal="true" aria-labelledby="studioImportTitle">
                <div class="studio-import-head">
                    <div class="studio-modal-title" id="studioImportTitle">Import from another AI</div>
                    <button class="btn-icon" data-close aria-label="Close">✕</button>
                </div>
                <div data-body></div>
            </div>
        `;
        document.body.appendChild(backdrop);
        const body = backdrop.querySelector("[data-body]");
        const close = () => {
            backdrop.remove();
            if (opener && typeof opener.focus === "function") opener.focus();
        };
        backdrop._close = close; // the studio's Escape handler closes through this
        backdrop.querySelector("[data-close]").addEventListener("click", close);
        // Only a press that started on the backdrop closes: a text selection dragged out of the dialog doesn't.
        let downOnBackdrop = false;
        backdrop.addEventListener("mousedown", (e) => {
            downOnBackdrop = e.target === backdrop;
        });
        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop && downOnBackdrop) close();
        });

        const st = {
            loading: true,
            sources: [],
            prompt: "",
            source: "chatgpt",
            text: "",
            file: null,
            facts: [],
            result: null,
        };
        const label = (id) => st.sources.find((s) => s.id === id)?.label || "the other app";
        const errorHtml = (msg) => `<div class="studio-import-error" role="alert">${_escapeHtml(msg)}</div>`;

        function renderPick(err) {
            const src = st.sources.find((s) => s.id === st.source);
            body.innerHTML = `
                <div class="studio-modal-body">Bring over what another assistant knows about you. Pick the app:</div>
                <div class="studio-modal-options" role="radiogroup" aria-label="App">
                    ${st.sources.map((s) => `<button class="studio-modal-option${s.id === st.source ? " active" : ""}" role="radio" aria-checked="${s.id === st.source}" data-src="${_escapeHtml(s.id)}">${_escapeHtml(s.label)}</button>`).join("")}
                </div>
                ${src ? `<div class="studio-import-hint">${_escapeHtml(src.hint)}</div>` : ""}
                <div class="studio-import-step">
                    <span>1. Paste this into ${_escapeHtml(label(st.source))}</span>
                    <button class="btn btn-secondary btn-sm" data-copy ${st.prompt ? "" : "disabled"}>Copy</button>
                </div>
                <textarea class="clean-input studio-import-prompt" readonly rows="4" aria-label="Prompt to copy">${_escapeHtml(st.prompt || (st.loading ? "Loading…" : ""))}</textarea>
                <div class="studio-import-step"><span>2. Paste its answer here</span></div>
                <textarea class="clean-input studio-import-paste" rows="6" placeholder="Paste the answer…" aria-label="Answer from the other app" data-paste>${_escapeHtml(st.text)}</textarea>
                <div class="studio-import-file">
                    <span>or</span>
                    <button class="btn btn-secondary btn-sm" data-file>Choose file…</button>
                    <span class="studio-import-filename">${st.file ? _escapeHtml(st.file.name) : ".txt, .md, .json or an export .zip"}</span>
                    ${st.file ? '<button class="btn-icon" data-unfile aria-label="Remove file">✕</button>' : ""}
                </div>
                ${err ? errorHtml(err) : ""}
                <div class="studio-modal-actions">
                    <button class="btn btn-secondary btn-sm" data-cancel>Cancel</button>
                    <button class="btn btn-primary btn-sm" data-next>Find memories</button>
                </div>
            `;
            const next = body.querySelector("[data-next]");
            const paste = body.querySelector("[data-paste]");
            const sync = () => {
                next.disabled = !(st.text.trim() || st.file);
            };
            sync();
            for (const b of body.querySelectorAll("[data-src]")) {
                b.addEventListener("click", () => {
                    st.source = b.getAttribute("data-src");
                    renderPick();
                    body.querySelector(`[data-src="${CSS.escape(st.source)}"]`)?.focus();
                });
            }
            // Whichever input was set last wins: typing drops a chosen file, picking a file clears the paste.
            paste.addEventListener("input", () => {
                st.text = paste.value;
                if (st.file && st.text.trim()) {
                    st.file = null;
                    body.querySelector("[data-unfile]")?.remove();
                    body.querySelector(".studio-import-filename").textContent = ".txt, .md, .json or an export .zip";
                }
                sync();
            });
            body.querySelector("[data-copy]").addEventListener("click", async (e) => {
                try {
                    await navigator.clipboard.writeText(st.prompt);
                    e.target.textContent = "Copied";
                } catch {
                    body.querySelector(".studio-import-prompt").select();
                }
            });
            body.querySelector("[data-file]").addEventListener("click", async () => {
                const res = await window.bhai.studio.pickImportFile();
                if (res && !res.canceled) {
                    st.file = { path: res.path, name: res.name };
                    st.text = "";
                    renderPick();
                }
            });
            body.querySelector("[data-unfile]")?.addEventListener("click", () => {
                st.file = null;
                renderPick();
            });
            body.querySelector("[data-cancel]").addEventListener("click", close);
            next.addEventListener("click", preview);
            (next.disabled ? paste : next).focus(); // the re-render dropped focus
        }

        async function preview() {
            body.innerHTML = `
                <div class="studio-import-busy" role="status">
                    <span class="studio-import-spinner" aria-hidden="true"></span>
                    Reading it and picking out what's about you… a big export can take a few minutes.
                </div>
            `;
            backdrop.querySelector("[data-close]").focus();
            let res;
            try {
                res = await window.bhai.studio.importPreview(
                    st.text.trim()
                        ? { text: st.text, source: st.source }
                        : { filePath: st.file.path, source: st.source },
                );
            } catch (err) {
                res = { success: false, error: err.message };
            }
            if (!backdrop.isConnected) return;
            if (!res?.success) return renderPick(res?.error || "Something went wrong. Try again.");
            if (res.detectedSource) st.source = res.detectedSource;
            // New facts first, checked up to the per-import cap; ones Bhai already has go last, unchecked.
            const facts = res.facts || [];
            st.facts = [...facts.filter((f) => !f.known), ...facts.filter((f) => f.known)];
            st.facts.forEach((f, i) => {
                f.keep = !f.known && i < IMPORT_CAP;
            });
            st.counts = res;
            renderReview();
        }

        function renderReview(err) {
            const c = st.counts;
            const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
            const fresh = st.facts.filter((f) => !f.known);
            const known = st.facts.length - fresh.length;
            const left = [];
            if (c.droppedInstructions) left.push(plural(c.droppedInstructions, "instruction-like line"));
            if (c.droppedSensitive) left.push(plural(c.droppedSensitive, "sensitive item"));
            const summary = [`${fresh.length} new`];
            if (known) summary.push(`${known} Bhai already knows`);
            if (left.length) summary.push(`${left.join(" and ")} left out`);
            if (c.truncated) {
                summary.push(
                    /_conversations$/.test(c.kind)
                        ? "only the newest chats were read"
                        : c.kind === "claude_memory"
                          ? "only part of it was read"
                          : "only the first part was read — import the rest separately",
                );
            }
            const notes = [];
            if (c.failedChunks > 0) {
                notes.push(
                    `<div class="studio-import-note" role="alert">${c.failedChunks} of ${plural(c.chunks || c.failedChunks, "part")} couldn't be read. <button class="btn btn-secondary btn-sm" data-retry>Try again</button></div>`,
                );
            }
            if (c.incomplete) {
                notes.push(
                    `<div class="studio-import-note">It says there's more — type "continue" there and paste the rest too.</div>`,
                );
            }
            body.innerHTML = `
                <div class="studio-modal-body">${_escapeHtml(summary.join(" · "))}.${fresh.length ? " Uncheck anything you don't want Bhai to remember." : ""}</div>
                ${notes.join("")}
                ${fresh.length ? `<label class="studio-import-all"><input type="checkbox" data-all /> Select all</label>` : ""}
                ${
                    st.facts.length
                        ? `
                    <ul class="studio-import-list">
                        ${st.facts
                            .map(
                                (f, i) => `
                            <li${f.known ? ' class="known"' : ""}><label>
                                <input type="checkbox" data-i="${i}" ${f.keep ? "checked" : ""} ${f.known ? "disabled" : ""} />
                                <span class="studio-import-fact">${_escapeHtml(f.content)}</span>
                                ${f.known ? '<span class="studio-pill studio-import-known">already knows</span>' : ""}
                                <span class="studio-pill">${_escapeHtml(f.category)}</span>
                            </label></li>
                        `,
                            )
                            .join("")}
                    </ul>
                `
                        : '<div class="studio-empty">Nothing about you turned up in that. Try pasting the full answer.</div>'
                }
                <div class="studio-import-hint" data-cap hidden>${IMPORT_CAP} per import. Uncheck some to pick others, or import the rest after.</div>
                ${err ? errorHtml(err) : ""}
                <div class="studio-modal-actions">
                    <button class="btn btn-secondary btn-sm" data-back>Back</button>
                    ${fresh.length ? '<button class="btn btn-primary btn-sm" data-save></button>' : ""}
                </div>
            `;
            const save = body.querySelector("[data-save]");
            const all = body.querySelector("[data-all]");
            const boxes = [...body.querySelectorAll("[data-i]")];
            const sync = () => {
                const n = fresh.filter((f) => f.keep).length;
                const full = n >= IMPORT_CAP;
                if (save) {
                    save.textContent = `Import ${n}`;
                    save.disabled = n === 0;
                }
                if (all) {
                    all.checked = n === Math.min(fresh.length, IMPORT_CAP);
                    all.indeterminate = n > 0 && !all.checked;
                }
                // At the cap, the unchecked new facts can't be checked until one is unchecked.
                boxes.forEach((box) => {
                    const f = st.facts[Number(box.getAttribute("data-i"))];
                    if (!f.known) box.disabled = full && !f.keep;
                });
                body.querySelector("[data-cap]").hidden = !(full && fresh.length > IMPORT_CAP);
            };
            sync();
            for (const box of boxes) {
                box.addEventListener("change", () => {
                    st.facts[Number(box.getAttribute("data-i"))].keep = box.checked;
                    sync();
                });
            }
            all?.addEventListener("change", () => {
                let room = all.checked ? IMPORT_CAP : 0;
                fresh.forEach((f) => {
                    f.keep = room-- > 0;
                });
                boxes.forEach((box) => {
                    box.checked = st.facts[Number(box.getAttribute("data-i"))].keep;
                });
                sync();
            });
            body.querySelector("[data-retry]")?.addEventListener("click", preview);
            body.querySelector("[data-back]").addEventListener("click", () => renderPick());
            (save || body.querySelector("[data-back]")).focus();
            save?.addEventListener("click", async () => {
                // Freeze the review while saving: no second save, and no Back/Try again to replace the Done screen.
                body.querySelectorAll("input, button").forEach((el) => {
                    el.disabled = true;
                });
                save.textContent = "Importing…";
                const facts = fresh
                    .filter((f) => f.keep)
                    .map(({ content, category, tags, importance }) => ({ content, category, tags, importance }));
                let res;
                try {
                    res = await window.bhai.studio.importSave(facts, st.source);
                } catch (err) {
                    res = { success: false, error: err.message };
                }
                if (res?.success) refresh(); // even if the modal was closed meanwhile
                if (!backdrop.isConnected) return;
                if (!res?.success) return renderReview(res?.error || "Couldn't save. Try again.");
                renderDone(res, facts);
            });
        }

        function renderDone(res, sent) {
            const parts = [`Added ${res.added || 0}`];
            if (res.duplicates) parts.push(`${res.duplicates} already known`);
            if (res.rejected) parts.push(`${res.rejected} skipped`);
            const msg = res.added
                ? `${parts.join(", ")}. You can remove any of them here in Memory.`
                : res.duplicates && !res.rejected
                  ? "Nothing new: Bhai already knew all of these."
                  : `${parts.join(", ")}.`;
            // ponytail: the save result has ids, not contents, so a duplicate or rejected fact can show here; fine for a preview of 5.
            const top = res.added
                ? [...sent].sort((a, b) => (b.importance || 0) - (a.importance || 0)).slice(0, Math.min(5, res.added))
                : [];
            const ids = Array.isArray(res.ids) ? res.ids : [];
            body.innerHTML = `
                ${
                    top.length
                        ? `
                    <div class="studio-modal-body">Bhai now knows things like:</div>
                    <ul class="studio-import-list studio-import-added">
                        ${top.map((f) => `<li><span class="studio-import-fact">${_escapeHtml(f.content)}</span></li>`).join("")}
                    </ul>
                `
                        : ""
                }
                <div class="studio-modal-body" role="status" data-msg>${_escapeHtml(msg)}</div>
                ${res.overCap > 0 ? `<div class="studio-import-note">${res.overCap} more weren't saved (${IMPORT_CAP} per import) — import again to add them.</div>` : ""}
                <div class="studio-modal-actions">
                    ${ids.length ? '<button class="btn btn-secondary btn-sm" data-undo>Undo this import</button>' : ""}
                    <button class="btn btn-primary btn-sm" data-done>Done</button>
                </div>
            `;
            const done = body.querySelector("[data-done]");
            done.addEventListener("click", close);
            body.querySelector("[data-undo]")?.addEventListener("click", async (e) => {
                const undo = e.currentTarget;
                undo.disabled = true;
                undo.textContent = "Undoing…";
                let r;
                try {
                    // The bot's batch undo also takes back the people, projects and profile fields
                    // this import added; deleting the rows here is the fallback when it can't.
                    if (res.batch && window.bhai.studio.importUndo)
                        r = await window.bhai.studio.importUndo(res.batch);
                    if (!r?.success) r = await window.bhai.studio.bulkForget(ids, "import_undo");
                } catch (err) {
                    r = { success: false, error: err.message };
                }
                if (r?.success) refresh();
                if (!backdrop.isConnected) return;
                if (!r?.success) {
                    undo.disabled = false;
                    undo.textContent = "Undo this import";
                    body.querySelector("[data-msg]").textContent =
                        `Couldn't undo: ${r?.error || "unknown error"}. Try again.`;
                    return;
                }
                body.innerHTML = `
                    <div class="studio-modal-body" role="status">Undone. Nothing from this import is in Bhai's memory now.</div>
                    <div class="studio-modal-actions"><button class="btn btn-primary btn-sm" data-done>Done</button></div>
                `;
                body.querySelector("[data-done]").addEventListener("click", close);
                body.querySelector("[data-done]").focus();
            });
            done.focus();
        }

        renderPick();
        backdrop.querySelector("[data-close]").focus();
        window.bhai.studio
            .importPrompt()
            .then((res) => {
                st.loading = false;
                if (!backdrop.isConnected || !body.querySelector("[data-paste]")) return;
                if (!res?.success) return renderPick(res?.error || "Couldn't reach Bhai.");
                st.sources = res.sources || [];
                st.prompt = res.prompt || "";
                renderPick();
                body.querySelector(".studio-modal-option.active")?.focus();
            })
            .catch((err) => {
                st.loading = false;
                renderPick(err.message);
            });
    }

    // ── Graph ─────────────
    // Grey dots, You in the accent colour, labels on You and the groups.

    function _resolvePalette() {
        const styles = getComputedStyle(document.documentElement);
        const v = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
        state.palette = {
            you: v("--accent-primary", "#c2570f"),
            node: v("--text-muted", "#8c8689"),
            anchor: v("--text-secondary", "#585253"),
        };
        return state.palette;
    }

    function _fill(d) {
        const p = state.palette;
        if (d.kind === "you") return p.you;
        return d.meta?.isCategoryAnchor ? p.anchor : p.node;
    }

    async function _loadGraphView() {
        const count = $("studioNodeCount");
        let res;
        try {
            res = await studio().graph({
                centerOnUser: true,
                hops: 1,
                includeAdvanced: state.advanced,
                includeSimilarity: false,
                windowDays: state.graphAll ? 0 : 90,
                maxNodes: state.graphAll ? 1000 : 400,
            });
        } catch (err) {
            res = { success: false, error: err.message };
        }
        if (!res?.success) {
            if (count) count.textContent = res?.error || "Couldn't load the graph.";
            return;
        }
        state.graph = res.graph;
        _renderGraph();
        if (state.query) {
            const found = await studio()
                .find(state.query)
                .catch(() => null);
            _highlightSet(new Set((found?.items || []).map((i) => i.id)));
        }
    }

    function _renderCount(nodes) {
        const el = $("studioNodeCount");
        if (!el) return;
        const shown = nodes.filter((n) => n.id.startsWith("mem:")).length;
        const total = state.stats?.memories ?? shown;
        const range = state.graphAll ? "all time" : "last 90 days";
        el.innerHTML =
            `Showing ${shown.toLocaleString()} of ${_plural(total, "memory")} · ${range}` +
            (state.graphAll ? "" : ' · <button type="button" class="studio-link" data-graph-all>show all</button>');
    }

    function _ensureSvg(container) {
        if (state.svg) return state.svg;
        if (typeof window.d3 === "undefined") {
            container.innerHTML =
                '<p class="studio-empty">The graph couldn\'t load. Reinstall the app to bring it back.</p>';
            return null;
        }
        const d3 = window.d3;
        const svg = d3.select(container).append("svg").attr("class", "studio-graph-svg");
        const gRoot = svg.append("g");
        state.gEdges = gRoot.append("g");
        state.gNodes = gRoot.append("g");
        state.gLabels = gRoot.append("g");
        state.zoom = d3
            .zoom()
            .scaleExtent([0.2, 3])
            .on("zoom", (event) => {
                gRoot.attr("transform", event.transform);
                state.zoomK = event.transform.k;
                // Small labels only once zoomed in; You and the groups keep theirs, at a readable size.
                state.gLabels.selectAll("text.minor").attr("opacity", state.zoomK >= 1.1 ? 1 : 0);
                state.gLabels.selectAll("text.prominent").style("font-size", `${12 / state.zoomK}px`);
            });
        svg.call(state.zoom);
        svg.on("click", (event) => {
            if (event.target === svg.node()) _select(null);
        });
        state.svg = svg;
        state.gRoot = gRoot;
        return svg;
    }

    function _renderGraph() {
        const container = $("studioGraph");
        if (!container || !state.graph) return;
        const svg = _ensureSvg(container);
        if (!svg) return;
        const d3 = window.d3;
        _resolvePalette();

        const kinds = new Set(TAB_KINDS[state.kind] || TAB_KINDS.all);
        const keep = (n) => n.kind === "you" || kinds.has(n.kind) || (state.advanced && ADVANCED_KINDS.has(n.kind));
        const nodes = state.graph.nodes.filter(keep).map((n) => ({ ...n }));
        const ids = new Set(nodes.map((n) => n.id));
        const end = (x) => (typeof x === "object" ? x.id : x);
        const edges = state.graph.edges
            .filter((e) => ids.has(end(e.source)) && ids.has(end(e.target)))
            .map((e) => ({ ...e }));
        _renderCount(nodes);

        const rect = container.getBoundingClientRect();
        const width = Math.max(rect.width, 320);
        const height = Math.max(rect.height, 320);
        svg.attr("viewBox", `${-width / 2} ${-height / 2} ${width} ${height}`);

        if (state.simulation) state.simulation.stop();
        const isAnchor = (n) => n.id.startsWith("cat:");
        const isHub = (n) => n.kind === "you" || isAnchor(n);
        const radius = (n) => (n.kind === "you" ? 12 : isAnchor(n) ? 7 : Math.max(3.5, (n.size || 10) / 3.2));

        const simulation = d3
            .forceSimulation(nodes)
            .force(
                "link",
                d3
                    .forceLink(edges)
                    .id((d) => d.id)
                    .distance((d) =>
                        isAnchor(d.source) || isAnchor(d.target)
                            ? 50
                            : d.source.kind === "you" || d.target.kind === "you"
                              ? 260
                              : 120,
                    )
                    .strength((d) => (isAnchor(d.source) || isAnchor(d.target) ? 0.8 : 0.1)),
            )
            .force(
                "charge",
                d3
                    .forceManyBody()
                    .strength((d) => (isHub(d) ? -900 : -120))
                    .distanceMax(700),
            )
            .force(
                "collide",
                d3.forceCollide().radius((d) => radius(d) + 6),
            )
            .force("x", d3.forceX(0).strength(0.02))
            .force("y", d3.forceY(0).strength(0.02))
            .alphaDecay(0.04);

        const edgeSel = state.gEdges
            .selectAll("line")
            .data(edges, (d) => `${end(d.source)}->${end(d.target)}::${d.kind}`)
            .join("line")
            .attr(
                "class",
                (d) => `studio-graph-edge${end(d.source) === "you" || end(d.target) === "you" ? " main" : ""}`,
            );

        const nodeSel = state.gNodes
            .selectAll("g.studio-graph-node")
            .data(nodes, (d) => d.id)
            .join((enter) => {
                const g = enter.append("g").attr("class", "studio-graph-node");
                g.append("circle");
                return g;
            })
            .classed("selected", (d) => d.id === state.selectedId)
            .classed("gone", (d) => state.hidden.has(d.id));
        nodeSel.select("circle").attr("r", radius).attr("fill", _fill);
        nodeSel
            .on("click", (event, d) => {
                event.stopPropagation();
                _select(d.id);
            })
            .on("mouseenter", (event, d) => _showTooltip(event, d))
            .on("mousemove", (event) => _moveTooltip(event))
            .on("mouseleave", _hideTooltip)
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
                        d.fx = null;
                        d.fy = null;
                    }),
            );

        const labelled = nodes.filter((n) => isHub(n) || n.kind === "entity" || (n.importance || 0) >= 0.7);
        const labelText = (d) => {
            const base = isAnchor(d) ? _catLabel(d.category) : d.label || "";
            return base.length <= 24 ? base : `${base.slice(0, 23)}…`;
        };
        const labelSel = state.gLabels
            .selectAll("text")
            .data(labelled, (d) => d.id)
            .join("text")
            .attr("class", (d) => `studio-graph-label${isHub(d) ? " prominent" : " minor"}`)
            .attr("text-anchor", "middle")
            .attr("y", (d) => radius(d) + 14)
            .attr("opacity", (d) => (isHub(d) || state.zoomK >= 1.1 ? 1 : 0))
            .style("font-size", (d) => (isHub(d) ? `${12 / state.zoomK}px` : null))
            .classed("gone", (d) => state.hidden.has(d.id))
            .text(labelText);

        simulation.on("tick", () => {
            edgeSel
                .attr("x1", (d) => d.source.x)
                .attr("y1", (d) => d.source.y)
                .attr("x2", (d) => d.target.x)
                .attr("y2", (d) => d.target.y);
            nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
            labelSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
        });
        let fitted = false;
        simulation.on("tick.fit", () => {
            if (!fitted && simulation.alpha() < 0.1) {
                fitted = true;
                _fitToView(nodes);
            }
        });
        state.simulation = simulation;
        if (state.selectedId) _highlightAdjacency(state.selectedId);
    }

    function _startGraph() {
        if (state.simulation) state.simulation.alpha(0.3).restart();
    }

    function _fitToView(nodes) {
        if (!state.svg || !nodes.length) return;
        const xs = nodes.map((n) => n.x).filter(Number.isFinite);
        const ys = nodes.map((n) => n.y).filter(Number.isFinite);
        if (!xs.length) return;
        const rect = $("studioGraph").getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const minX = Math.min(...xs),
            maxX = Math.max(...xs),
            minY = Math.min(...ys),
            maxY = Math.max(...ys);
        const k = Math.max(
            0.3,
            Math.min(
                1.6,
                Math.min((rect.width - 80) / Math.max(maxX - minX, 1), (rect.height - 80) / Math.max(maxY - minY, 1)),
            ),
        );
        const t = window.d3.zoomIdentity.translate(-((minX + maxX) / 2) * k, -((minY + maxY) / 2) * k).scale(k);
        state.svg.transition().duration(400).call(state.zoom.transform, t);
    }

    function _highlightSet(ids) {
        if (!state.gNodes) return;
        const on = ids && ids.size > 0;
        state.gNodes.selectAll("g.studio-graph-node").classed("faded", (d) => on && !ids.has(d.id) && d.kind !== "you");
        state.gEdges.selectAll("line").classed("faded", on);
        state.gLabels.selectAll("text").classed("faded", (d) => on && !ids.has(d.id) && d.kind !== "you");
    }

    function _highlightAdjacency(id) {
        if (!state.gNodes || !state.graph) return;
        state.gNodes.selectAll("g.studio-graph-node").classed("selected", (d) => d.id === id);
        if (!id) return _highlightSet(null);
        const adj = new Set([id]);
        state.gEdges.selectAll("line").each((d) => {
            if (d.source.id === id) adj.add(d.target.id);
            if (d.target.id === id) adj.add(d.source.id);
        });
        _highlightSet(adj);
        state.gEdges.selectAll("line").classed("faded", (d) => d.source.id !== id && d.target.id !== id);
    }

    function _anchorMembers(anchorId) {
        if (!state.graph) return [];
        const out = [];
        for (const e of state.graph.edges) {
            const src = typeof e.source === "object" ? e.source.id : e.source;
            const tgt = typeof e.target === "object" ? e.target.id : e.target;
            if (src !== anchorId) continue;
            const n = state.graph.nodes.find((x) => x.id === tgt);
            if (n) out.push({ id: tgt, name: n.label });
            if (out.length >= 8) break;
        }
        return out;
    }

    function _showTooltip(event, d) {
        if (!state.tooltip) return;
        const label = d.id.startsWith("cat:") ? _catLabel(d.category) : d.label;
        const when = d.id.startsWith("cat:") ? "" : _timeAgo(d.createdAt);
        state.tooltip.innerHTML = `<strong>${_escapeHtml(label)}</strong><br><span>${_escapeHtml([KIND_LABEL[d.kind] || d.kind, when].filter(Boolean).join(" · "))}</span>`;
        state.tooltip.hidden = false;
        _moveTooltip(event);
    }

    function _moveTooltip(event) {
        if (!state.tooltip) return;
        const rect = $("studioGraph").getBoundingClientRect();
        let x = event.clientX - rect.left + 12;
        let y = event.clientY - rect.top + 12;
        if (x + 240 > rect.width) x -= 260;
        if (y + 60 > rect.height) y -= 70;
        state.tooltip.style.left = `${x}px`;
        state.tooltip.style.top = `${y}px`;
    }

    function _hideTooltip() {
        if (state.tooltip) state.tooltip.hidden = true;
    }

    function _watchTheme() {
        if (state.themeObserver) return;
        state.themeObserver = new MutationObserver(() => {
            _resolvePalette();
            state.gNodes?.selectAll("g.studio-graph-node circle").attr("fill", _fill);
        });
        state.themeObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
        state.themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "data-theme"],
        });
    }

    // ── Forget log (⋯ menu) ─────────────

    async function _toggleForgetLog(btn) {
        const pane = $("studioDeletedPane");
        const open = pane.getAttribute("data-open") === "true";
        pane.setAttribute("data-open", String(!open));
        btn.textContent = open ? "Forget log" : "Hide forget log";
        if (open) return;
        pane.innerHTML = '<p class="studio-empty">Loading…</p>';
        const res = await studio()
            .forgetLog(50)
            .catch((err) => ({ success: false, error: err.message }));
        if (!res?.success) {
            pane.innerHTML = `<p class="studio-empty">${_escapeHtml(res?.error || "Couldn't load the log.")}</p>`;
            return;
        }
        const rows = res.entries || [];
        pane.innerHTML = rows.length
            ? `<p class="studio-row-meta">What was forgotten is gone; this only keeps when and why.</p>` +
              rows
                  .map(
                      (r) =>
                          `<div class="studio-deleted-row">${_escapeHtml(KIND_LABEL[r.kind] || r.kind)} · ${_escapeHtml(_timeAgo(r.forgotten_at))} · ${_escapeHtml(r.reason || "")}</div>`,
                  )
                  .join("")
            : '<p class="studio-empty">Nothing forgotten yet.</p>';
    }

    // ── Wiring ─────────────

    function _wire() {
        const search = $("studioSearch");
        search?.addEventListener("input", () => {
            clearTimeout(state.searchTimer);
            state.searchTimer = setTimeout(() => {
                state.query = search.value.trim();
                _reload();
            }, 250);
        });
        $("studioTabs")?.addEventListener("click", (e) => {
            const b = e.target.closest("[data-kind]");
            if (b) _setTab(b.getAttribute("data-kind"));
        });
        $("studioViews")?.addEventListener("click", (e) => {
            const b = e.target.closest("[data-view]");
            if (b && b.getAttribute("data-view") !== state.view) _setView(b.getAttribute("data-view"));
        });
        $("studioList")?.addEventListener("click", _onListClick);
        $("studioDetail")?.addEventListener("click", _onDetailClick);
        $("studioReview")?.addEventListener("click", _onReviewClick);
        $("studioSummary")?.addEventListener("click", (e) => {
            if (e.target.closest("[data-review]")) _openReview();
        });
        $("studioToast")?.addEventListener("click", (e) => {
            if (e.target.closest("[data-undo]")) _undo();
        });
        $("studioGraphWrap")?.addEventListener("click", (e) => {
            if (e.target.closest("[data-graph-all]")) {
                state.graphAll = true;
                _loadGraphView();
                return;
            }
            const z = e.target.closest("[data-zoom]")?.getAttribute("data-zoom");
            if (!z || !state.svg) return;
            if (z === "fit") _fitToView(state.simulation?.nodes() || []);
            else
                state.svg
                    .transition()
                    .duration(150)
                    .call(state.zoom.scaleBy, z === "in" ? 1.3 : 1 / 1.3);
        });
        $("studioImportOpen")?.addEventListener("click", _openImportModal);
        const menu = $("studioMore");
        $("studioDeletedToggle")?.addEventListener("click", (e) => {
            menu.open = false;
            _toggleForgetLog(e.currentTarget);
        });
        $("studioAdvancedToggle")?.addEventListener("click", (e) => {
            menu.open = false;
            state.advanced = !state.advanced;
            e.currentTarget.textContent = state.advanced ? "Hide goals and learnings" : "Show goals and learnings";
            if (state.view !== "graph") _setView("graph");
            else _loadGraphView();
        });

        const wrap = $("studioGraph");
        const tip = document.createElement("div");
        tip.className = "studio-graph-tooltip";
        tip.hidden = true;
        wrap.appendChild(tip);
        state.tooltip = tip;
    }

    function _isStudioActive() {
        return !!$("tab-memory")?.classList.contains("active");
    }

    function _isInTextInput(target) {
        const tag = (target?.tagName || "").toUpperCase();
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!target?.isContentEditable;
    }

    function _onKeydown(event) {
        if (!_isStudioActive()) return;
        const modal = document.querySelector(".studio-modal-backdrop");
        if (event.key === "Escape") {
            if (modal) return void (typeof modal._close === "function" ? modal._close() : modal.remove());
            const menu = $("studioMore");
            if (menu?.open) {
                menu.open = false;
                return;
            }
            if (state.reviewOpen) return _closeReview();
            if (state.selectedId) {
                event.preventDefault();
                _select(null);
            }
            return;
        }
        if (modal || _isInTextInput(event.target) || (event.metaKey && event.key !== "Backspace")) return;
        if (event.key === "/" && !state.reviewOpen) {
            event.preventDefault();
            $("studioSearch")?.focus();
            return;
        }
        const node = state.selectedId && _nodeFor(state.selectedId);
        if (!node) return;
        const btn = (act) => $("studioDetail")?.querySelector(`[data-act="${act}"]`);
        if (event.key === "e" || event.key === "E") {
            event.preventDefault();
            btn("edit")?.click();
        } else if (event.key === "p" || event.key === "P") {
            event.preventDefault();
            btn("pin")?.click();
        } else if (event.key === "Delete" || (event.key === "Backspace" && event.metaKey)) {
            event.preventDefault();
            btn("forget")?.click();
        }
    }

    function _onResize() {
        if (!state.svg || state.view !== "graph") return;
        const rect = $("studioGraph").getBoundingClientRect();
        state.svg.attr(
            "viewBox",
            `${-Math.max(rect.width, 320) / 2} ${-Math.max(rect.height, 320) / 2} ${Math.max(rect.width, 320)} ${Math.max(rect.height, 320)}`,
        );
    }

    async function mount() {
        if (!state.mounted) {
            state.mounted = true;
            _wire();
            _watchTheme();
            window.addEventListener("resize", _onResize);
            document.addEventListener("keydown", _onKeydown);
            window.addEventListener("beforeunload", _flushPending);
        } else if (state.view === "graph") _startGraph();
        await refresh();
    }

    // Leaving the page lets a waiting forget go through.
    function pause() {
        if (state.simulation) state.simulation.stop();
        _flushPending();
    }

    function destroy() {
        pause();
        state.themeObserver?.disconnect();
        state.themeObserver = null;
        window.removeEventListener("resize", _onResize);
        document.removeEventListener("keydown", _onKeydown);
        window.removeEventListener("beforeunload", _flushPending);
        Object.assign(state, {
            simulation: null,
            svg: null,
            gRoot: null,
            gEdges: null,
            gNodes: null,
            gLabels: null,
            zoom: null,
            graph: null,
            mounted: false,
        });
        const container = $("studioGraph");
        if (container) container.innerHTML = "";
    }

    window.MemoryStudio = { mount, refresh, pause, destroy, openImport: _openImportModal };
})();
