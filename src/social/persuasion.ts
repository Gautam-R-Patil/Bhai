// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Persuasion Module — MADS-style evidence-based persuasion with Chain-of-Attitude.

export type Attitude = "resistant" | "skeptical" | "neutral" | "receptive" | "convinced";

export interface PersuasionStrategy {
    strategy: "evidence" | "authority" | "social_proof" | "scarcity" | "reciprocity" | "consistency";
    message: string;
    expectedAttitudeShift: number; // -1 to 1
}

export interface AttitudeState {
    topic: string;
    currentAttitude: Attitude;
    attitudeScore: number; // -1 (resistant) to 1 (convinced)
    history: Array<{ strategy: string; response: Attitude; timestamp: number }>;
}

const attitudes = new Map<string, AttitudeState>();

export function getAttitude(topic: string): AttitudeState {
    return attitudes.get(topic) || {
        topic, currentAttitude: "neutral", attitudeScore: 0, history: [],
    };
}

export function recordAttitudeShift(topic: string, strategy: string, newAttitude: Attitude): void {
    const state = getAttitude(topic);
    const scoreMap: Record<Attitude, number> = { resistant: -1, skeptical: -0.5, neutral: 0, receptive: 0.5, convinced: 1 };
    state.attitudeScore = scoreMap[newAttitude] ?? 0;
    state.currentAttitude = newAttitude;
    state.history.push({ strategy, response: newAttitude, timestamp: Date.now() });
    attitudes.set(topic, state);
}

export function selectStrategy(state: AttitudeState): PersuasionStrategy {
    // Evidence is the default and most effective for "neutral" and "skeptical"
    if (state.currentAttitude === "skeptical" || state.currentAttitude === "neutral") {
        return { strategy: "evidence", message: "Present data and facts to support the recommendation.", expectedAttitudeShift: 0.3 };
    }
    if (state.currentAttitude === "resistant") {
        return { strategy: "social_proof", message: "Show that others have benefited from this approach.", expectedAttitudeShift: 0.2 };
    }
    if (state.currentAttitude === "receptive") {
        return { strategy: "consistency", message: "Remind them of their previous positive statements about this.", expectedAttitudeShift: 0.3 };
    }
    return { strategy: "evidence", message: "Present supporting evidence.", expectedAttitudeShift: 0.1 };
}
