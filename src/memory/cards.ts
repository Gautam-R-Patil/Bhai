// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { ageLabel, getRawDb, type MemoryRecord, recallableSql } from "./sqlite.js";

const MAX_ENTITIES = 3; // per card kind
const MAX_FACTS = 3; // per person/project
const MAX_LIST = 5; // preferences, commitments
// Capitalized words that start sentences, not names.
const NOT_NAMES = new Set(
    "the a an he she it they we you my our his her their this that these those what when where who why how can could will would should do does did is are was please also and but so if hey hi ok yes no".split(
        " ",
    ),
);

/** memory_store tags: person:/project: names lowercased and space-collapsed, other tags kept as given. */
export function normalizeTags(tags: string): string {
    return tags
        .split(",")
        .map((t) => {
            const m = t.trim().match(/^(person|project)\s*:\s*(.+)$/i);
            return m ? `${m[1].toLowerCase()}:${m[2].trim().toLowerCase().replace(/\s+/g, " ")}` : t.trim();
        })
        .filter(Boolean)
        .join(",");
}

const tagNames = (tags: string, kind: string) =>
    normalizeTags(tags || "")
        .split(",")
        .filter((t) => t.startsWith(`${kind}:`))
        .map((t) => t.slice(kind.length + 1));

const hasWord = (text: string, word: string) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu").test(text);

const title = (name: string) => name.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());

const fact = (m: MemoryRecord) =>
    `${m.content.replace(/\s+/g, " ").slice(0, 160)} (#${m.id} · ${ageLabel(m.created_at)}${m.pinned ? " · pinned" : ""})`;

/**
 * People / Projects / Preferences / Commitments cards for the owner's first iteration. People and
 * projects come from person:/project: tags named in the message (or a capitalized name from the
 * message that starts an untagged 'person' row); recalled preference/commitment rows join their
 * cards. `rest` is the recalled remainder for the plain list; `ids` are every memory the cards show. Rows in `skip` are left out.
 */
export function buildMemoryCards(
    message: string,
    recalled: MemoryRecord[],
    skip: Set<number> = new Set(),
): { cards: string; ids: number[]; rest: MemoryRecord[] } {
    const caps = (message.match(/(?<![\p{L}\p{N}])\p{Lu}\p{L}+/gu) ?? []).filter(
        (c) => !NOT_NAMES.has(c.toLowerCase()),
    );
    const capsLower = new Set(caps.map((c) => c.toLowerCase()));
    // ponytail: scans up to 500 tagged/person rows per owner turn; add a tag table if it grows past that.
    const rows = (
        (getRawDb()
            ?.prepare(
                `SELECT id, content, category, tags, importance, created_at, access_count, COALESCE(pinned, 0) AS pinned
             FROM memories
             WHERE consolidated_into IS NULL AND scope = 'global' AND (decay_score > 0.2 OR pinned = 1)
               AND ${recallableSql()} AND category != 'session_summary'
               AND (tags LIKE '%person:%' OR tags LIKE '%project:%' OR category = 'person')
             ORDER BY COALESCE(pinned, 0) DESC, created_at DESC, id DESC LIMIT 500`,
            )
            .all() ?? []) as MemoryRecord[]
    ).map((r) => ({ ...r, pinned: !!r.pinned }));

    const named = (n: string) => hasWord(message, n) || capsLower.has(n.split(" ")[0]);
    const people = new Map<string, MemoryRecord[]>();
    const projects = new Map<string, MemoryRecord[]>();
    const entity = (m: MemoryRecord): [Map<string, MemoryRecord[]>, string] | null => {
        const person = tagNames(m.tags, "person").find(named);
        if (person) return [people, person];
        const project = tagNames(m.tags, "project").find(named);
        if (project) return [projects, project];
        // Untagged person rows are written name-first ("Arjun plays the guitar").
        const token =
            m.category === "person"
                ? caps.find((c) => new RegExp(`^${c}(?![\\p{L}\\p{N}])`, "u").test(m.content))
                : undefined;
        return token ? [people, token.toLowerCase()] : null;
    };

    const prefs: MemoryRecord[] = [];
    const commits: MemoryRecord[] = [];
    const rest: MemoryRecord[] = [];
    const seen = new Set(skip);
    const recalledIds = new Set(recalled.map((m) => m.id));
    for (const m of [...recalled, ...rows]) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const fromRecall = recalledIds.has(m.id);
        const hit = entity(m);
        if (!hit && !fromRecall) continue;
        let placed = false;
        if (m.category === "commitment") {
            if (commits.length < MAX_LIST) placed = !!commits.push(m);
        } else if (hit) {
            const [map, key] = hit;
            const list = map.get(key) ?? (map.size < MAX_ENTITIES ? [] : null);
            if (list && list.length < MAX_FACTS) placed = !!map.set(key, [...list, m]);
        } else if (m.category === "preference" && prefs.length < MAX_LIST) {
            placed = !!prefs.push(m);
        }
        if (!placed && fromRecall) rest.push(m);
    }

    const lines = [
        ...[...people].map(([n, ms]) => `PEOPLE — ${title(n)}: ${ms.map(fact).join("; ")}`),
        ...[...projects].map(([n, ms]) => `PROJECTS — ${title(n)}: ${ms.map(fact).join("; ")}`),
        ...(prefs.length ? [`PREFERENCES — ${prefs.map(fact).join("; ")}`] : []),
        ...(commits.length ? [`COMMITMENTS — ${commits.map(fact).join("; ")}`] : []),
    ];
    const ids = [...people.values(), ...projects.values(), prefs, commits].flat().map((m) => m.id);
    return {
        cards: lines.length
            ? `🗂️ CARDS (what you know about who and what this message mentions):\n${lines.join("\n")}`
            : "",
        ids,
        rest,
    };
}
