// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Research saved before 9ea0072f sat at importance 8-10 (never fades, fills core memory):
// capped once to the levels research is stored at now. Nothing is deleted.
import BetterSqlite3 from "better-sqlite3";
import { expect, it } from "vitest";
import { capResearchImportance } from "../at-rest-scrub.js";

it("caps old research importance once, and leaves other memories alone", () => {
    const db = new BetterSqlite3(":memory:");
    db.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, content TEXT, category TEXT, importance INTEGER)");
    const ins = db.prepare("INSERT INTO memories (content, category, importance) VALUES (?, ?, ?)");
    ins.run('Deep research completed on "metro": no firm date', "research", 10);
    ins.run('Research report on "metro" saved to ~/Documents/Research/', "research", 9);
    ins.run("[Research: metro] Phase 2 opens in 2026", "research", 8);
    ins.run("[Research: metro] a minor detail", "research", 5);
    ins.run("Owner's sister is Priya", "fact", 10);

    expect(capResearchImportance(db)).toBe(3);
    const imp = db.prepare("SELECT importance FROM memories ORDER BY id").all().map((r) => (r as { importance: number }).importance);
    expect(imp).toEqual([7, 6, 6, 5, 10]);
    expect(capResearchImportance(db)).toBeNull(); // once
});
