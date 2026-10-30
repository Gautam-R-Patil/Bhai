// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// One turn's live view as plain data, from the bot's turn_* messages. The same contract as the
// overlay's turnView/turnRoute (src/overlay/overlay.html); copied because the extension is
// packaged on its own. Tested by src/chrome-extension-turn-view.test.ts.

// {turn, seq, status, steps, notes, answer, attempt, open}. A message whose seq isn't newer
// changes nothing; another turn's message starts a fresh view. attempt null = unknown (a
// snapshot doesn't say which attempt its answer is), so the next delta just carries on.
export function turnView(state, msg) {
    if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("turn_")) return state;
    const same = !!state && state.turn === msg.turn;
    if (same && typeof msg.seq === "number" && msg.seq <= state.seq) return state;
    const s = same
        ? { ...state }
        : { turn: msg.turn, seq: 0, status: null, steps: [], notes: [], answer: "", attempt: 0, open: !!state?.open };
    if (typeof msg.seq === "number") s.seq = msg.seq;
    switch (msg.type) {
        case "turn_snapshot":
            s.status = msg.status || null;
            s.steps = Array.isArray(msg.steps)
                ? msg.steps.map((x) => ({ id: x.id, text: x.text, state: x.state }))
                : [];
            s.notes = Array.isArray(msg.notes) ? msg.notes.slice() : [];
            s.answer = typeof msg.answer === "string" ? msg.answer : "";
            s.attempt = null;
            break;
        case "turn_status":
            s.status = { text: msg.text || "", step: msg.step || 0, elapsed: msg.elapsed || 0 };
            break;
        case "turn_step": {
            const step = { id: msg.id, text: msg.text || "", state: msg.state };
            const i = s.steps.findIndex((x) => x.id === msg.id);
            s.steps = i < 0 ? [...s.steps, step] : s.steps.map((x, j) => (j === i ? step : x));
            break;
        }
        case "turn_note":
            s.notes = [...s.notes, msg.text || ""];
            break;
        case "turn_answer":
            if (s.attempt === null) s.attempt = msg.attempt;
            if (msg.attempt < s.attempt) return state; // a withdrawn attempt's late text
            if (msg.attempt > s.attempt) {
                s.attempt = msg.attempt;
                s.answer = "";
            }
            s.answer += msg.text || "";
            break;
        case "turn_answer_reset":
            s.answer = "";
            s.attempt = Math.max(s.attempt || 0, (msg.attempt || 0) + 1);
            break;
        default:
            return state;
    }
    return s;
}

// Where a message goes while a live view may be on screen. liveTurn = the view's turn or null,
// running = it hasn't finished. Returns 'apply' (to the view), 'start' (a new view first),
// 'finish' (the view's reply), 'plain' (no live view involved) or 'ignore'.
export function turnRoute(liveTurn, running, msg) {
    if (msg.type === "response" || msg.type === "error") {
        if (!running) return "plain";
        return msg.type === "error" || !msg.turn || msg.turn === liveTurn ? "finish" : "ignore";
    }
    if (liveTurn !== null && msg.turn === liveTurn) return "apply";
    return running && msg.type !== "turn_snapshot" ? "ignore" : "start";
}
