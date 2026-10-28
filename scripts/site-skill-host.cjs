// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
//
// Runs one Site Skill in its own process (src/skills/site/host.ts forks it per
// task). A throw, hang, process.exit or OOM in the skill ends this process,
// never the bot. One JSON message in ({id, phase, ctx}), one out.
let skill;
try {
    skill = require(process.argv[2]);
} catch (e) {
    skill = { loadError: String((e && e.message) || e).slice(0, 300) };
}

process.on("message", async (m) => {
    if (!m || typeof m.id !== "number") return;
    if (skill.loadError || typeof skill.step !== "function") {
        process.send({ id: m.id, ok: false, kind: "load_error", error: skill.loadError || "no step() export" });
        return;
    }
    try {
        const result = await skill.step(m.phase, m.ctx);
        process.send({ id: m.id, ok: true, result });
    } catch (e) {
        process.send({ id: m.id, ok: false, kind: "handler_error", error: String((e && e.message) || e).slice(0, 300) });
    }
});
