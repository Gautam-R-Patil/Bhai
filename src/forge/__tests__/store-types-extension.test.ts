// Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.

import { describe, it, expect } from "vitest";
import type { StoreItemType, LocalInstallManifest } from "../../store/types.js";

describe("store types accept dynamic", () => {
	it("StoreItemType union includes dynamic", () => {
		const t: StoreItemType = "dynamic";
		expect(t).toBe("dynamic");
	});

	it("LocalInstallManifest item entry accepts forgeMeta", () => {
		const m: LocalInstallManifest = {
			items: {
				foo: {
					itemId: "forge_foo",
					type: "dynamic",
					name: "foo",
					version: "1.0.0",
					installedAt: Date.now(),
					autoUpdate: false,
					path: "/Users/x/.bhai/store/dynamic/foo",
					forgeMeta: { source: "synchronous" },
				},
			},
			lastUpdated: Date.now(),
		};
		expect(m.items.foo.type).toBe("dynamic");
	});
});
