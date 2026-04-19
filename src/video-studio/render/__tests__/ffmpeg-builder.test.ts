// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { FilterComplexBuilder } from "../ffmpeg-builder.js";

describe("FilterComplexBuilder — labels", () => {
    it("assigns unique counter-based labels", () => {
        const b = new FilterComplexBuilder();
        const l0 = b.addTrim(0, 0, 5);
        const l1 = b.addTrim(0, 5, 10);
        const l2 = b.addTrim(0, 10, 15);
        expect(l0).toBe("[l0]");
        expect(l1).toBe("[l1]");
        expect(l2).toBe("[l2]");
    });

    it("labels remain unique across 20+ operations", () => {
        const b = new FilterComplexBuilder();
        const labels = new Set<string>();
        for (let i = 0; i < 20; i++) labels.add(b.addTrim(0, i, i + 1));
        expect(labels.size).toBe(20);
    });

    it("setOutputVideoLabel + setOutputAudioLabel are reflected in build()", () => {
        const b = new FilterComplexBuilder();
        const v = b.addTrim(0, 0, 5);
        const a = b.addAudioMix(["[0:a]"], {});
        b.setOutputVideoLabel(v);
        b.setOutputAudioLabel(a);
        const result = b.build();
        expect(result.outputLabels.video).toBe(v);
        expect(result.outputLabels.audio).toBe(a);
    });
});

describe("FilterComplexBuilder — addTrim", () => {
    it("produces trim=start=X:end=Y fragment with setpts", () => {
        const b = new FilterComplexBuilder();
        b.addTrim(0, 3.2, 8.4);
        expect(b.build().filterGraph).toBe("[0:v]trim=start=3.2:end=8.4,setpts=PTS-STARTPTS[l0]");
    });

    it("handles different source indices", () => {
        const b = new FilterComplexBuilder();
        b.addTrim(2, 0, 1);
        expect(b.build().filterGraph).toContain("[2:v]trim");
    });
});

describe("FilterComplexBuilder — addConcat", () => {
    it("joins multiple labels with concat=n=N", () => {
        const b = new FilterComplexBuilder();
        const a = b.addTrim(0, 0, 5);
        const c = b.addTrim(1, 0, 5);
        b.addConcat([a, c]);
        const graph = b.build().filterGraph;
        expect(graph).toContain("concat=n=2:v=1:a=0");
        expect(graph).toContain(a);
        expect(graph).toContain(c);
    });
});

describe("FilterComplexBuilder — addXfade", () => {
    it("produces xfade=transition=K:duration=D fragment", () => {
        const b = new FilterComplexBuilder();
        const a = b.addTrim(0, 0, 5);
        const c = b.addTrim(1, 0, 5);
        b.addXfade(a, c, "fade", 1.0);
        const graph = b.build().filterGraph;
        expect(graph).toContain("xfade=transition=fade:duration=1");
    });

    it("includes offset when provided", () => {
        const b = new FilterComplexBuilder();
        const a = b.addTrim(0, 0, 5);
        const c = b.addTrim(1, 0, 5);
        b.addXfade(a, c, "wipeleft", 0.5, 4.5);
        expect(b.build().filterGraph).toContain(":offset=4.5");
    });

    it("omits offset when not provided", () => {
        const b = new FilterComplexBuilder();
        const a = b.addTrim(0, 0, 5);
        const c = b.addTrim(1, 0, 5);
        b.addXfade(a, c, "dissolve", 0.3);
        expect(b.build().filterGraph).not.toContain(":offset=");
    });
});

describe("FilterComplexBuilder — addOverlay", () => {
    it("produces overlay without params when opts empty", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        const ov = b.addTrim(1, 0, 5);
        b.addOverlay(base, ov, {});
        expect(b.build().filterGraph).toMatch(/overlay\[l\d+\]$/);
    });

    it("produces overlay=x=X:y=Y when coordinates given", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        const ov = b.addTrim(1, 0, 5);
        b.addOverlay(base, ov, { x: 100, y: 200 });
        expect(b.build().filterGraph).toContain("overlay=x=100:y=200");
    });

    it("includes enable='...' expression", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 10);
        const ov = b.addTrim(1, 0, 10);
        b.addOverlay(base, ov, { enable: "between(t,0,5)" });
        expect(b.build().filterGraph).toContain("enable='between(t,0,5)'");
    });
});

describe("FilterComplexBuilder — addDrawtext", () => {
    it("escapes backslash, single quote, and colon in text", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addDrawtext(base, "a:b\\c'd", {});
        const graph = b.build().filterGraph;
        expect(graph).toContain("text='a\\:b\\\\c\\'d'");
    });

    it("includes fontsize, fontcolor, x, y when provided", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addDrawtext(base, "Hi", { fontsize: 48, fontcolor: "white", x: 10, y: 20 });
        const graph = b.build().filterGraph;
        expect(graph).toContain("fontsize=48");
        expect(graph).toContain("fontcolor=white");
        expect(graph).toContain("x=10");
        expect(graph).toContain("y=20");
    });

    it("includes box=1 when box is true", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addDrawtext(base, "Hi", { box: true, boxcolor: "black@0.5" });
        const graph = b.build().filterGraph;
        expect(graph).toContain("box=1");
        expect(graph).toContain("boxcolor=black@0.5");
    });
});

describe("FilterComplexBuilder — addSubtitles", () => {
    it("includes subtitles='<path>' with colons escaped", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 30);
        b.addSubtitles(base, "/tmp/caps.ass");
        const graph = b.build().filterGraph;
        expect(graph).toContain("subtitles='/tmp/caps.ass'");
    });

    it("escapes colons in Windows-style paths", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addSubtitles(base, "C:\\caps.ass");
        const graph = b.build().filterGraph;
        expect(graph).toContain("C\\:");
    });
});

describe("FilterComplexBuilder — addAudioMix", () => {
    it("produces amix=inputs=N fragment", () => {
        const b = new FilterComplexBuilder();
        b.addAudioMix(["[0:a]", "[1:a]"], {});
        expect(b.build().filterGraph).toContain("amix=inputs=2");
    });

    it("includes normalize=0 when normalize: false", () => {
        const b = new FilterComplexBuilder();
        b.addAudioMix(["[0:a]"], { normalize: false });
        expect(b.build().filterGraph).toContain("normalize=0");
    });

    it("includes duration= when provided", () => {
        const b = new FilterComplexBuilder();
        b.addAudioMix(["[0:a]"], { duration: "longest" });
        expect(b.build().filterGraph).toContain("duration=longest");
    });
});

describe("FilterComplexBuilder — build()", () => {
    it("joins fragments with ';' separator", () => {
        const b = new FilterComplexBuilder();
        b.addTrim(0, 0, 5);
        b.addTrim(0, 5, 10);
        expect(b.build().filterGraph.split(";")).toHaveLength(2);
    });

    it("returns empty string when no fragments added", () => {
        const b = new FilterComplexBuilder();
        expect(b.build().filterGraph).toBe("");
    });
});

describe("FilterComplexBuilder — addAutoCrop", () => {
    it("produces sendcmd=f='<path>',crop=<initial> fragment", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addAutoCrop(base, "/tmp/sendcmd.txt", "607:1080:656:0");
        const graph = b.build().filterGraph;
        expect(graph).toContain("sendcmd=f=");
        expect(graph).toContain("crop=607:1080:656:0");
    });

    it("backslash path separators are converted to forward slashes", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addAutoCrop(base, "C:\\renders\\sendcmd.txt", "607:1080:656:0");
        const graph = b.build().filterGraph;
        expect(graph).not.toContain("\\renders\\");
        expect(graph).toContain("/renders/sendcmd.txt");
    });

    it("colons in path escaped for FFmpeg filter syntax", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addAutoCrop(base, "C:/renders/sendcmd.txt", "607:1080:656:0");
        const graph = b.build().filterGraph;
        expect(graph).toContain("C\\:");
    });

    it("returns a label that chains into next filter", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        const cropOut = b.addAutoCrop(base, "/tmp/cmd.txt", "607:1080:0:0");
        b.addDrawtext(cropOut, "Test", { fontsize: 24 });
        expect(b.build().filterGraph).toContain(cropOut);
    });

    it("initialCrop string included verbatim", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addAutoCrop(base, "/tmp/sc.txt", "999:888:11:22");
        expect(b.build().filterGraph).toContain("crop=999:888:11:22");
    });
});

describe("FilterComplexBuilder — addAlphaMerge", () => {
    it("produces a 2-fragment chain: alphamerge then overlay", () => {
        const b = new FilterComplexBuilder();
        const fg = b.addTrim(0, 0, 5);
        b.addAlphaMerge(fg, "[1:v]", "[2:v]");
        const graph = b.build().filterGraph;
        const parts = graph.split(";");
        expect(parts).toHaveLength(3);
        expect(parts[1]).toContain("alphamerge");
        expect(parts[2]).toContain("overlay");
    });

    it("returns the final overlay output label", () => {
        const b = new FilterComplexBuilder();
        const fg = b.addTrim(0, 0, 5);
        const out = b.addAlphaMerge(fg, "[1:v]", "[2:v]");
        expect(out).toMatch(/^\[l\d+\]$/);
        expect(b.build().filterGraph).toContain(out);
    });
});

describe("FilterComplexBuilder — addColorGrade", () => {
    it("warm preset includes colortemperature=temperature=5500", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addColorGrade(base, "warm");
        expect(b.build().filterGraph).toContain("colortemperature=temperature=5500");
    });

    it("cool preset includes colortemperature=temperature=7500", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addColorGrade(base, "cool");
        expect(b.build().filterGraph).toContain("colortemperature=temperature=7500");
    });

    it("vintage preset includes curves=vintage", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addColorGrade(base, "vintage");
        expect(b.build().filterGraph).toContain("curves=vintage");
    });

    it("mono preset includes hue=s=0", () => {
        const b = new FilterComplexBuilder();
        const base = b.addTrim(0, 0, 5);
        b.addColorGrade(base, "mono");
        expect(b.build().filterGraph).toContain("hue=s=0");
    });
});
