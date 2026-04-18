// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// Pragmatic Communication — Detect implicature and indirect requests.
// Gricean maxims for informative but concise responses.

export interface PragmaticAnalysis {
    isIndirectRequest: boolean;
    impliedMeaning: string;
    directInterpretation: string;
    confidence: number;
}

const INDIRECT_PATTERNS: Array<{ pattern: RegExp; meaning: string }> = [
    { pattern: /can you/i, meaning: "Please do this" },
    { pattern: /would it be possible/i, meaning: "Please do this" },
    { pattern: /i was wondering if/i, meaning: "Please do this" },
    { pattern: /do you know (how|if|where|when|what)/i, meaning: "Tell me / help me with" },
    { pattern: /i('m| am) having (trouble|difficulty|issues|problems)/i, meaning: "Fix this for me" },
    { pattern: /it would be (nice|great|helpful|good) if/i, meaning: "Please do this" },
    { pattern: /have you (tried|considered|thought about)/i, meaning: "I want to discuss this approach" },
    { pattern: /what do you think about/i, meaning: "Give me your analysis of" },
    { pattern: /i('m| am) not sure (how|if|about)/i, meaning: "Help me understand" },
];

export function analyzePragmatics(message: string): PragmaticAnalysis {
    for (const { pattern, meaning } of INDIRECT_PATTERNS) {
        if (pattern.test(message)) {
            const match = message.match(pattern);
            return {
                isIndirectRequest: true,
                impliedMeaning: `${meaning}: ${message.replace(match?.[0] || "", "").trim()}`,
                directInterpretation: message,
                confidence: 0.7,
            };
        }
    }
    return { isIndirectRequest: false, impliedMeaning: message, directInterpretation: message, confidence: 0.9 };
}
