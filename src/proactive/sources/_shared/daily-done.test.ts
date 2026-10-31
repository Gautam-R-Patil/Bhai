// © 2024-2026 TRUSCOR Private Limited. All rights reserved.
// Morning news/weather run once a day, and a restart doesn't reset that.
import { expect, it, vi } from "vitest";

it("a source done today stays done after a restart, and runs again tomorrow", async () => {
    const day = new Date(2026, 9, 30, 8, 0).getTime(); // local 8am
    let mod = await import("./daily-done.js");
    expect(mod.doneToday("news_morning", day)).toBe(false);
    mod.markDoneToday("news_morning", day);
    expect(mod.doneToday("news_morning", day + 6 * 3600_000)).toBe(true); // 2pm, same day
    expect(mod.doneToday("weather_morning", day)).toBe(false); // per source

    vi.resetModules(); // the bot restarted
    mod = await import("./daily-done.js");
    expect(mod.doneToday("news_morning", day + 3600_000)).toBe(true);
    expect(mod.doneToday("news_morning", day + 24 * 3600_000)).toBe(false); // tomorrow
});
