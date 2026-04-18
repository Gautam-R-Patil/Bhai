// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

export interface DrawtextStyle {
    fontsize?: number;
    fontcolor?: string;
    fontfile?: string;
    x?: number;
    y?: number;
    box?: boolean;
    boxcolor?: string;
    enable?: string;
}

export interface AudioMixOpts {
    normalize?: boolean;
    duration?: "first" | "longest" | "shortest";
}

export interface BuildResult {
    filterGraph: string;
    outputLabels: { video: string; audio: string };
}

export class FilterComplexBuilder {
    private counter = 0;
    private fragments: string[] = [];
    private _outputVideoLabel = "";
    private _outputAudioLabel = "";

    private nextLabel(): string {
        const label = `[l${this.counter}]`;
        this.counter++;
        return label;
    }

    setOutputVideoLabel(label: string): void {
        this._outputVideoLabel = label;
    }

    setOutputAudioLabel(label: string): void {
        this._outputAudioLabel = label;
    }

    addTrim(sourceIdx: number, inSec: number, outSec: number): string {
        const out = this.nextLabel();
        this.fragments.push(`[${sourceIdx}:v]trim=start=${inSec}:end=${outSec},setpts=PTS-STARTPTS${out}`);
        return out;
    }

    addConcat(labels: string[]): string {
        const out = this.nextLabel();
        this.fragments.push(`${labels.join("")}concat=n=${labels.length}:v=1:a=0${out}`);
        return out;
    }

    addXfade(labelA: string, labelB: string, kind: string, duration: number, offset?: number): string {
        const out = this.nextLabel();
        const offsetPart = offset !== undefined ? `:offset=${offset}` : "";
        this.fragments.push(`${labelA}${labelB}xfade=transition=${kind}:duration=${duration}${offsetPart}${out}`);
        return out;
    }

    addOverlay(baseLabel: string, overlayLabel: string, opts: { x?: number; y?: number; enable?: string }): string {
        const out = this.nextLabel();
        const parts: string[] = [];
        if (opts.x !== undefined) parts.push(`x=${opts.x}`);
        if (opts.y !== undefined) parts.push(`y=${opts.y}`);
        if (opts.enable) parts.push(`enable='${opts.enable}'`);
        const params = parts.length > 0 ? `=${parts.join(":")}` : "";
        this.fragments.push(`${baseLabel}${overlayLabel}overlay${params}${out}`);
        return out;
    }

    addDrawtext(baseLabel: string, text: string, style: DrawtextStyle): string {
        const out = this.nextLabel();
        const escaped = text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:");
        const parts: string[] = [`text='${escaped}'`];
        if (style.fontsize !== undefined) parts.push(`fontsize=${style.fontsize}`);
        if (style.fontcolor) parts.push(`fontcolor=${style.fontcolor}`);
        if (style.fontfile) parts.push(`fontfile='${style.fontfile.replace(/:/g, "\\:")}'`);
        if (style.x !== undefined) parts.push(`x=${style.x}`);
        if (style.y !== undefined) parts.push(`y=${style.y}`);
        if (style.box) parts.push("box=1");
        if (style.boxcolor) parts.push(`boxcolor=${style.boxcolor}`);
        if (style.enable) parts.push(`enable='${style.enable}'`);
        this.fragments.push(`${baseLabel}drawtext=${parts.join(":")}${out}`);
        return out;
    }

    addSubtitles(baseLabel: string, assPath: string): string {
        const out = this.nextLabel();
        const escaped = assPath.replace(/\\/g, "/").replace(/:/g, "\\:");
        this.fragments.push(`${baseLabel}subtitles='${escaped}'${out}`);
        return out;
    }

    addAudioMix(audioLabels: string[], opts: AudioMixOpts): string {
        const out = this.nextLabel();
        const n = audioLabels.length;
        const normPart = opts.normalize === false ? ":normalize=0" : "";
        const durPart = opts.duration ? `:duration=${opts.duration}` : "";
        this.fragments.push(`${audioLabels.join("")}amix=inputs=${n}${normPart}${durPart}${out}`);
        return out;
    }

    build(): BuildResult {
        return {
            filterGraph: this.fragments.join(";"),
            outputLabels: { video: this._outputVideoLabel, audio: this._outputAudioLabel },
        };
    }
}
