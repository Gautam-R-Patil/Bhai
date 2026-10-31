// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// One research run leaves one summary memory that also says where the report is.
import { expect, it, vi } from "vitest";

const saved: string[] = [];
vi.mock("../memory/sqlite.js", () => ({ remember: (text: string) => saved.push(text) }));

const { storeResearchInMemory } = await import("./persistence.js");

it("the report's location rides on the summary memory", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const report = "# Mesh Wi-Fi\n\n## Executive Summary\nTenda ME3 Pro is the cheapest Wi-Fi 7 mesh.\n\n## Findings\n...";
    await storeResearchInMemory("mesh wifi", [], report, "research_1", "/r/mesh.md");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^Deep research completed on "mesh wifi": Tenda ME3 Pro .*research_id research_1.*\/r\/mesh\.md/);

    saved.length = 0;
    await storeResearchInMemory("no summary", [], "# Report without a summary", "research_2", "/r/x.md");
    expect(saved).toEqual([expect.stringContaining("research_id research_2")]);
});
