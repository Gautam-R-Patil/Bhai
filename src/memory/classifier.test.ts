// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

import { describe, expect, it } from "vitest";
import { classifyQuery } from "./classifier.js";

describe("classifyQuery — action verb after a greeting/ack", () => {
    it("does NOT treat an action request opening with an ack as llm_only", () => {
        // 2-token tail slipped past the {0,2} cap before the ACTION_VERB_RE guard.
        expect(classifyQuery("ok delete everything")).toBe("llm_with_traits");
        expect(classifyQuery("sure send it")).toBe("llm_with_traits");
        expect(classifyQuery("yo open chrome")).toBe("llm_with_traits");
    });

    it("still classifies pure greetings/acks as llm_only", () => {
        expect(classifyQuery("hi")).toBe("llm_only");
        expect(classifyQuery("thanks")).toBe("llm_only");
        expect(classifyQuery("ok cool")).toBe("llm_only");
        expect(classifyQuery("good night")).toBe("llm_only");
    });

    it("keeps retrieving history even when the query contains an action verb", () => {
        expect(classifyQuery("remind me what we decided yesterday")).toBe("retrieve");
    });
});
