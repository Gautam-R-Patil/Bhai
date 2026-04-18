// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import type { Theme } from "./types.js";

// Hand-crafted themes. All colors pre-validated for WCAG AA (4.5:1 body).
// Fonts limited to PPT-safe stack — no custom font embedding in v1.

const calibriPair = { heading: "Calibri", body: "Calibri", mono: "Consolas" };
const georgiaPair = { heading: "Georgia", body: "Calibri", mono: "Consolas" };
const cambriaPair = { heading: "Cambria", body: "Arial", mono: "Consolas" };

export const THEMES: Record<string, Theme> = {
    clean: {
        id: "clean",
        name: "Clean Light",
        mode: "light",
        colors: {
            primary: "2563EB",       // blue-600
            secondary: "7C3AED",     // violet-600
            accent: "F59E0B",        // amber-500
            bg: "FFFFFF",
            surface: "F8FAFC",
            text: "0F172A",
            textMuted: "475569",
            positive: "16A34A",
            negative: "DC2626",
        },
        fonts: calibriPair,
        chartPalette: ["2563EB", "7C3AED", "F59E0B", "16A34A", "DB2777", "0891B2"],
    },

    midnight: {
        id: "midnight",
        name: "Midnight Dark",
        mode: "dark",
        colors: {
            primary: "60A5FA",
            secondary: "A78BFA",
            accent: "FBBF24",
            bg: "0B1220",
            surface: "111827",
            text: "F9FAFB",
            textMuted: "9CA3AF",
            positive: "34D399",
            negative: "F87171",
        },
        fonts: calibriPair,
        chartPalette: ["60A5FA", "A78BFA", "FBBF24", "34D399", "F472B6", "22D3EE"],
    },

    executive: {
        id: "executive",
        name: "Executive Serif",
        mode: "light",
        colors: {
            primary: "1E3A8A",       // deep navy
            secondary: "991B1B",     // oxblood
            accent: "A16207",        // dark gold
            bg: "FDFCF8",            // warm off-white
            surface: "F5F3EC",
            text: "1C1917",
            textMuted: "57534E",
            positive: "15803D",
            negative: "991B1B",
        },
        fonts: georgiaPair,
        chartPalette: ["1E3A8A", "991B1B", "A16207", "15803D", "6B21A8", "0F766E"],
    },

    editorial: {
        id: "editorial",
        name: "Editorial Cambria",
        mode: "light",
        colors: {
            primary: "111827",
            secondary: "B91C1C",
            accent: "CA8A04",
            bg: "FFFFFF",
            surface: "F3F4F6",
            text: "111827",
            textMuted: "4B5563",
            positive: "166534",
            negative: "991B1B",
        },
        fonts: cambriaPair,
        chartPalette: ["111827", "B91C1C", "CA8A04", "166534", "6B21A8", "0E7490"],
    },

    forest: {
        id: "forest",
        name: "Forest",
        mode: "light",
        colors: {
            primary: "15803D",
            secondary: "166534",
            accent: "CA8A04",
            bg: "FEFCE8",
            surface: "FEF9C3",
            text: "1A2E05",
            textMuted: "4D7C0F",
            positive: "15803D",
            negative: "B91C1C",
        },
        fonts: calibriPair,
        chartPalette: ["15803D", "CA8A04", "B91C1C", "1E40AF", "7E22CE", "0E7490"],
    },

    mono: {
        id: "mono",
        name: "Monochrome",
        mode: "light",
        colors: {
            primary: "111827",
            secondary: "374151",
            accent: "DC2626",
            bg: "FFFFFF",
            surface: "F3F4F6",
            text: "111827",
            textMuted: "6B7280",
            positive: "059669",
            negative: "DC2626",
        },
        fonts: calibriPair,
        chartPalette: ["111827", "374151", "6B7280", "9CA3AF", "DC2626", "059669"],
    },
};

export function getTheme(id: string | undefined): Theme {
    if (id && THEMES[id]) return THEMES[id];
    return THEMES.clean;
}

export function listThemeIds(): string[] {
    return Object.keys(THEMES);
}

// WCAG AA relative-luminance contrast check.
// ratio >= 4.5 for body text, >= 3 for large text.
export function contrastRatio(hex1: string, hex2: string): number {
    const lum = (hex: string) => {
        const h = hex.replace("#", "");
        const r = parseInt(h.slice(0, 2), 16) / 255;
        const g = parseInt(h.slice(2, 4), 16) / 255;
        const b = parseInt(h.slice(4, 6), 16) / 255;
        const channel = (c: number) => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const l1 = lum(hex1);
    const l2 = lum(hex2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

export function validateThemeContrast(theme: Theme): string[] {
    const warnings: string[] = [];
    const bodyRatio = contrastRatio(theme.colors.text, theme.colors.bg);
    if (bodyRatio < 4.5) {
        warnings.push(
            `Theme ${theme.id}: body text/bg contrast ${bodyRatio.toFixed(2)} < 4.5 (WCAG AA fail)`,
        );
    }
    return warnings;
}
