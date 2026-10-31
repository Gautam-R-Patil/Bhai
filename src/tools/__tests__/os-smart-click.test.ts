// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The background press looks up real running apps (lsappinfo): off here, so these tests
// don't depend on what's open on the machine.
process.env.BHAI_NO_BACKGROUND_PRESS = "true";

const findClickTarget = vi.fn();
const click = vi.fn();
const classify = vi.fn();
const recall = vi.fn((): unknown => null);
const recordMiss = vi.fn();
const press = vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ ok: false, error: "unsupported:AXPress" }));
let window = { x: 0, y: 0, w: 1000, h: 800 };
const activeWindow = vi.fn(async () => ({ app: "unknown", title: "" }));
// Set to fake one external command (by name); everything else runs for real.
const fakeExec = vi.hoisted(() => ({
    cmd: "",
    calls: [] as string[][],
    result: ((_args: string[]) => Promise.resolve({ stdout: "" })) as (args: string[]) => Promise<unknown>,
}));
vi.mock("node:child_process", async (orig) => {
    const real = await orig<typeof import("node:child_process")>();
    const { promisify } = await import("node:util");
    const realAsync = promisify(real.execFile);
    return {
        ...real,
        execFile: Object.assign((...a: Parameters<typeof real.execFile>) => real.execFile(...a), {
            [promisify.custom]: (cmd: string, args: string[], opts: object) => {
                if (cmd !== fakeExec.cmd) return realAsync(cmd, args, opts);
                fakeExec.calls.push(args);
                return fakeExec.result(args);
            },
        }),
    };
});

vi.mock("../../screen/perception-router.js", () => ({ findClickTarget, formatCascadeResult: () => "" }));
vi.mock("../../screen/outcome-classifier.js", () => ({ classifyOutcomeFromImages: classify }));
vi.mock("../../screen/ax-dump.js", () => ({
    dumpAccessibilityTree: async () => ({ app: "Calculator", root: {} }),
    axPerformAction: press,
}));
vi.mock("../../screen/click-memory.js", () => ({
    recallClickSite: recall,
    recordClickMiss: recordMiss,
    recordClickSuccess: () => {},
}));
vi.mock("../../screen/drift-calibration.js", () => ({
    applyCalibration: (_m: string, x: number, y: number) => ({ x, y }),
    recordCalibrationSample: () => {},
}));
vi.mock("../../screen/screen-dimensions.js", () => ({
    getScreenDimensions: async () => ({
        width: 1470,
        height: 956,
        originX: 0,
        originY: 0,
        monitorId: "m",
        focusedWindow: window,
    }),
    isFallbackDims: () => false,
    captureRegion: async () => Buffer.from("png"),
}));
vi.mock("../platform-bridge.js", () => ({
    takeScreenshot: async () => Buffer.from("png"),
    getActiveWindow: activeWindow,
}));
// Clicks are counted; the hover-first mouse_move before a verified click is not.
vi.mock("../os-computer-action.js", () => ({
    executeStructuredAction: async (act: { action: string }) => {
        if (act.action !== "mouse_move") click(act);
        return {};
    },
}));

const { osSmartClick, setSmartClickLLM } = await import("../os-smart-click.js");
const { MODELS } = await import("../../llm.js");

const cloudHit = (x: number) => ({ x, y: 50, confidence: 0.9, source: "cloud_grounding" });

describe("os_smart_click grounding", () => {
    beforeEach(() => {
        vi.useRealTimers();
        findClickTarget.mockReset();
        click.mockClear();
        classify.mockReset();
        classify.mockResolvedValue({ outcome: "success" });
        recordMiss.mockClear();
        press.mockClear();
        setSmartClickLLM({} as never);
        recall.mockReset();
        recall.mockReturnValue(null);
        window = { x: 0, y: 0, w: 1000, h: 800 };
    });

    it("click memory follows the window, and ignores a resized one", async () => {
        const row = {
            xNorm: 0.5,
            yNorm: 0.5,
            confidence: 0.95,
            successCount: 6,
            lastScreenWidth: 400,
            lastScreenHeight: 300,
        };
        recall.mockReturnValue(row);
        window = { x: 500, y: 100, w: 400, h: 300 };
        const out = JSON.parse(await osSmartClick.handler({ instruction: "=" }));
        expect(out).toMatchObject({ success: true, source: "memory", clicked: { x: 700, y: 250 } });

        window = { x: 500, y: 100, w: 600, h: 300 }; // resized → re-ground, don't trust the row
        findClickTarget.mockResolvedValueOnce({ x: 10, y: 10, confidence: 0.99, source: "ax_exact" });
        const again = JSON.parse(await osSmartClick.handler({ instruction: "=" }));
        expect(again.source).toBe("ax_exact");
    });

    it("app hint Dock tells the cascade to search the Dock first; other apps do not", async () => {
        findClickTarget.mockResolvedValue({ x: 10, y: 10, confidence: 0.99, source: "ax_exact" });
        await osSmartClick.handler({ instruction: "Safari", app: "Dock" });
        expect(findClickTarget.mock.calls[0][1].dockFirst).toBe(true);
        await osSmartClick.handler({ instruction: "Safari" });
        expect(findClickTarget.mock.calls[1][1].dockFirst).toBe(false);
    });

    it("re-grounds a verified Haiku miss once with Sonnet", async () => {
        findClickTarget.mockResolvedValueOnce(cloudHit(100)).mockResolvedValueOnce(cloudHit(140));
        // no_op twice: still nothing after the slow-UI second look.
        classify
            .mockResolvedValueOnce({ outcome: "no_op" })
            .mockResolvedValueOnce({ outcome: "no_op" })
            .mockResolvedValueOnce({ outcome: "success" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "the 2 button" }));
        expect(out.success).toBe(true);
        expect(findClickTarget).toHaveBeenCalledTimes(2);
        expect(findClickTarget.mock.calls[0][1].groundingModel).toBeUndefined(); // Haiku default
        expect(findClickTarget.mock.calls[1][1].groundingModel).toBe(MODELS.SONNET);
        expect(findClickTarget.mock.calls[1][1].skipTiers).not.toContain("cloud_grounding");
        expect(click).toHaveBeenCalledTimes(2);
    });

    it("a click whose effect is just slow (nothing at 300ms, changed after) is not clicked again", async () => {
        findClickTarget.mockResolvedValueOnce(cloudHit(100)).mockResolvedValueOnce(cloudHit(140));
        classify.mockResolvedValueOnce({ outcome: "no_op" }).mockResolvedValueOnce({ outcome: "success" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Send" }));
        expect(out.success).toBe(true);
        expect(click).toHaveBeenCalledTimes(1); // no second Send
        expect(recordMiss).not.toHaveBeenCalled();
    });

    it("a click that changed something elsewhere (wrong_target) is not clicked again", async () => {
        findClickTarget.mockResolvedValueOnce(cloudHit(100)).mockResolvedValueOnce(cloudHit(300));
        classify.mockResolvedValueOnce({ outcome: "wrong_target" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Send" }));
        expect(out.success).toBe(false);
        expect(click).toHaveBeenCalledTimes(1);
    });

    it("a menu-bar click outside the window is remembered against the monitor", async () => {
        recall.mockReturnValue({
            xNorm: 60 / 1470,
            yNorm: 10 / 956,
            confidence: 0.95,
            successCount: 6,
            lastScreenWidth: 1470,
            lastScreenHeight: 956,
        });
        window = { x: 500, y: 300, w: 400, h: 300 };
        const out = JSON.parse(await osSmartClick.handler({ instruction: "File menu" }));
        expect(out.clicked).toEqual({ x: 60, y: 10 });
    });

    it("a remembered spot that does nothing is forgotten and re-grounded", async () => {
        recall.mockReturnValue({
            xNorm: 0.5,
            yNorm: 0.5,
            confidence: 0.95,
            successCount: 6,
            lastScreenWidth: 1000,
            lastScreenHeight: 800,
        });
        classify.mockResolvedValueOnce({ outcome: "no_op" }).mockResolvedValueOnce({ outcome: "no_op" });
        findClickTarget.mockResolvedValueOnce({ x: 10, y: 10, confidence: 0.99, source: "ax_exact" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "=" }));
        expect(recordMiss).toHaveBeenCalledTimes(1);
        expect(out.source).toBe("ax_exact");
        expect(click).toHaveBeenCalledTimes(2);
    });

    it("a remembered spot that hit something else is not clicked again", async () => {
        recall.mockReturnValue({
            xNorm: 0.5,
            yNorm: 0.5,
            confidence: 0.95,
            successCount: 6,
            lastScreenWidth: 1000,
            lastScreenHeight: 800,
        });
        classify.mockResolvedValueOnce({ outcome: "wrong_target" });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Send" }));
        expect(out).toMatchObject({ success: false, error: "click_unverified", source: "memory" });
        expect(recordMiss).toHaveBeenCalledTimes(1);
        expect(click).toHaveBeenCalledTimes(1);
        expect(findClickTarget).not.toHaveBeenCalled();
    });

    it("an AX hit is pressed via AXPress when the element supports it", async () => {
        press.mockResolvedValueOnce({ ok: true, frame: { x: 0, y: 0, w: 20, h: 20 } });
        const ax = { pid: 42, path: [0, 3], role: "AXButton", bbox: { x: 0, y: 0, w: 20, h: 20 } };
        findClickTarget.mockResolvedValueOnce({ x: 10, y: 10, confidence: 0.99, source: "ax_exact", ax });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "OK" }));
        expect(out).toMatchObject({ success: true, verified: "ax_press" });
        expect(press).toHaveBeenCalledWith(42, ax, "press");
        expect(click).not.toHaveBeenCalled();
    });

    it("an off-screen AX element that can't be revealed is an error, not an edge click", async () => {
        const ax = { pid: 42, path: [0], role: "AXRow", bbox: { x: 0, y: 2000, w: 20, h: 20 }, offscreen: true };
        findClickTarget.mockResolvedValueOnce({
            x: 10,
            y: 2010,
            confidence: 0.99,
            source: "ax_exact",
            ax,
            matchedLabel: "Row",
        });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Row" }));
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/element_offscreen/);
        expect(click).not.toHaveBeenCalled();
    });

    it("never clicks once grounding outlives the deadline", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        findClickTarget.mockImplementationOnce(async () => {
            vi.setSystemTime(Date.now() + 41_000); // grounding took 41s
            return cloudHit(100);
        });
        const out = JSON.parse(await osSmartClick.handler({ instruction: "Send" }));
        expect(out.success).toBe(false);
        expect(out.error).toMatch(/nothing was clicked/);
        expect(click).not.toHaveBeenCalled();
    });

    describe("off macOS, the named app", () => {
        const realPlatform = process.platform;
        const envKeys = ["WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "XDG_DATA_HOME", "XDG_DATA_DIRS"];
        const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
        const fail = (props: object) => Promise.reject(Object.assign(new Error("exec failed"), props));
        const timedOut = () => fail({ killed: true, code: null, signal: "SIGTERM" });
        // Installed apps, as their .desktop files describe them.
        const share = mkdtempSync(join(tmpdir(), "smart-click-xdg-"));
        mkdirSync(join(share, "applications"));
        const desktop = (file: string, body: string) =>
            writeFileSync(join(share, "applications", file), `[Desktop Entry]\nType=Application\n${body}\n`);
        desktop("org.gnome.TextEditor.desktop", "Name=Text Editor\nName[de]=Texteditor\nExec=gnome-text-editor %U");
        desktop("xed.desktop", "Name=Text Editor\nExec=xed %U");
        desktop("org.gnome.Evince.desktop", "Name=Document Viewer\nExec=evince %U");
        desktop("org.gnome.eog.desktop", "Name=Image Viewer\nExec=eog %U");
        desktop("org.gnome.Loupe.desktop", "Name=Image Viewer\nExec=loupe %U");
        desktop("spotify.desktop", "Name=Spotify\nExec=spotify %U\nStartupWMClass=spotify");
        desktop("kitty.desktop", "Name=kitty\nGenericName=Terminal emulator\nExec=kitty\nCategories=System;TerminalEmulator;");
        desktop("sublime_text.desktop", "Name=Sublime Text\nGenericName=Text Editor\nExec=subl %F\nCategories=TextEditor;Development;");
        desktop(
            "org.gnome.Terminal.desktop",
            "Name=Terminal\nExec=gnome-terminal\n\n[Desktop Action new-window]\nName=New Window\nExec=gnome-terminal --window",
        );
        // X11 windows wmctrl sees: -a matches a title, -x -a a WM_CLASS (substring, any case); exit 1 = none.
        let x11: { title: string; cls: string }[] = [];
        const wmctrl = (args: string[]) => {
            const want = args[args.length - 1].toLowerCase();
            const byClass = args.includes("-x");
            return x11.some((w) => (byClass ? w.cls : w.title).toLowerCase().includes(want))
                ? Promise.resolve({ stdout: "" })
                : fail({ code: 1 });
        };
        const run = async (os: string, cmd: string, result: (args: string[]) => Promise<unknown>, app: string) => {
            Object.defineProperty(process, "platform", { value: os });
            Object.assign(fakeExec, { cmd, result, calls: [] });
            findClickTarget.mockResolvedValue(cloudHit(100));
            return JSON.parse(await osSmartClick.handler({ instruction: "Save", app }));
        };
        beforeEach(() => {
            delete process.env.WAYLAND_DISPLAY;
            process.env.XDG_SESSION_TYPE = "x11";
            process.env.XDG_DATA_HOME = join(share, "nothing-here");
            process.env.XDG_DATA_DIRS = share;
            activeWindow.mockReset();
            activeWindow.mockResolvedValue({ app: "unknown", title: "" });
            x11 = [];
        });
        afterEach(() => {
            Object.defineProperty(process, "platform", { value: realPlatform });
            fakeExec.cmd = "";
            for (const [k, v] of Object.entries(savedEnv)) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        });
        afterAll(() => rmSync(share, { recursive: true, force: true }));

        describe("win32", () => {
            // AppActivate by title answers first; a second script prints the real app names the name
            // resolves to (its exe via PATH/App Paths/Start Menu, running processes), then True once
            // one of their windows is activated.
            const powershell =
                (byTitle: string, byProcess = "") =>
                (args: string[]) =>
                    Promise.resolve({ stdout: `${/Get-Process/.test(args[2]) ? byProcess : byTitle}\r\n` });
            const outlook = { app: "OUTLOOK", title: "Inbox - me@example.com - Outlook" };

            it("a window titled with the app's name is activated as before, with no extra probe", async () => {
                const out = await run("win32", "powershell", powershell("True"), "Notepad");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
                expect(fakeExec.calls).toHaveLength(1);
                expect(activeWindow).not.toHaveBeenCalled();
            });

            it.each([
                ["File Explorer", { app: "explorer", title: "Downloads" }],
                ["Spotify", { app: "Spotify", title: "Artist - Song" }],
            ])("%s already in front under another title is clicked without activating another window", async (app, w) => {
                activeWindow.mockResolvedValue(w);
                const out = await run("win32", "powershell", powershell("False", "True"), app);
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
                expect(fakeExec.calls).toHaveLength(1);
            });

            it("Spotify behind Outlook, titled after the song, is brought forward by its process", async () => {
                activeWindow.mockResolvedValue(outlook);
                const out = await run(
                    "win32",
                    "powershell",
                    powershell("False", "Spotify\r\nspotify\r\nTrue"),
                    "Spotify",
                );
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
                expect(fakeExec.calls).toHaveLength(2);
            });

            // AppActivate matches a title's start or end, Get-Process a process name: neither is the
            // name the model used for these, so the front window has to be recognised another way.
            it.each([
                ["VS Code", { app: "Code", title: "index.ts - bhai - Visual Studio Code" }, ""],
                [
                    "Adobe Acrobat",
                    { app: "Acrobat", title: "doc.pdf - Adobe Acrobat Reader (64-bit)" },
                    "Acrobat\r\nAcrobat",
                ],
                [
                    "OBS Studio",
                    { app: "obs64", title: "OBS 30.2.3 - Profile: Untitled - Scenes: Untitled" },
                    "obs64\r\nobs64\r\nTrue",
                ],
                ["Control Panel", { app: "explorer", title: "All Control Panel Items" }, ""],
            ])("%s in front (process %s) is clicked, not refused", async (app, w, byProcess) => {
                activeWindow.mockResolvedValue(w);
                const out = await run("win32", "powershell", powershell("False", byProcess), app);
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });

            it("a cmd console in front with Terminal asked (no Windows Terminal running) is clicked", async () => {
                activeWindow.mockResolvedValue({ app: "cmd", title: "C:\\WINDOWS\\system32\\cmd.exe" });
                const out = await run("win32", "powershell", powershell("False", ""), "Terminal");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });

            it("a name nothing on the PC answers to stays best-effort, as before", async () => {
                activeWindow.mockResolvedValue(outlook);
                const out = await run("win32", "powershell", powershell("False", ""), "VS Code");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });

            it("Adobe Acrobat closed (its Start Menu shortcut names Acrobat.exe) with Outlook in front is refused", async () => {
                activeWindow.mockResolvedValue(outlook);
                const out = await run("win32", "powershell", powershell("False", "Acrobat"), "Adobe Acrobat");
                expect(out.success).toBe(false);
                expect(out.error).toMatch(/could not bring "Adobe Acrobat" to the front/);
                expect(click).not.toHaveBeenCalled();
            });

            it("Notepad closed with Outlook in front is refused, not clicked in Outlook", async () => {
                activeWindow.mockResolvedValue(outlook);
                // Get-Command finds C:\WINDOWS\system32\notepad.exe; no notepad process runs.
                const out = await run("win32", "powershell", powershell("False", "notepad"), "Notepad");
                expect(out.success).toBe(false);
                expect(out.error).toMatch(/could not bring "Notepad" to the front/);
                expect(click).not.toHaveBeenCalled();
            });

            it.each([
                ["no answer", { app: "unknown", title: "" }],
                ["its own PowerShell", { app: "powershell", title: "Inbox - me@example.com - Outlook" }],
                ["a UWP app's frame host", { app: "ApplicationFrameHost", title: "Calculator" }],
            ])("when the active-window helper gives %s, a miss stays best-effort", async (_why, w) => {
                activeWindow.mockResolvedValue(w);
                const out = await run("win32", "powershell", powershell("False"), "Notepad");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });

            it("a timed-out activation stays best-effort", async () => {
                const out = await run("win32", "powershell", timedOut, "Notepad");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });
        });

        describe("linux", () => {
            const firefox = { title: "Example Domain — Mozilla Firefox", cls: "Navigator.firefox" };
            const firefoxFront = { app: "firefox", title: "Example Domain — Mozilla Firefox" };
            const classLookups = () => fakeExec.calls.filter((a) => a.includes("-x"));

            it.each([
                ["Text Editor", "gnome-text-edit", "Untitled Document 1", "org.gnome.TextEditor.Org.gnome.TextEditor"],
                ["Text Editor", "xed", "Unsaved Document 1", "xed.Xed"],
                ["Document Viewer", "evince", "report.pdf", "evince.Evince"],
                ["Image Viewer", "eog", "photo.jpg", "eog.Eog"],
                ["Image Viewer", "loupe", "photo.jpg", "org.gnome.Loupe.Org.gnome.Loupe"],
                ["Terminal", "gnome-terminal-", "me@box: ~", "gnome-terminal-server.Gnome-terminal"],
            ])("X11: %s in front as %s, titled %j, is clicked without raising another window", async (app, comm, title, cls) => {
                x11 = [{ title, cls }, firefox];
                activeWindow.mockResolvedValue({ app: comm, title });
                const out = await run("linux", "wmctrl", wmctrl, app);
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
                expect(classLookups()).toHaveLength(0);
            });

            it("X11: Spotify behind Firefox, titled after the song, is raised by its WM_CLASS", async () => {
                x11 = [firefox, { title: "Artist - Song", cls: "spotify.Spotify" }];
                activeWindow.mockResolvedValue(firefoxFront);
                const out = await run("linux", "wmctrl", wmctrl, "Spotify");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
                expect(classLookups()[0]).toEqual(["-x", "-a", "spotify"]);
            });

            it("X11: Text Editor with no window, Firefox in front, is refused", async () => {
                x11 = [firefox, { title: "me@box: ~", cls: "gnome-terminal-server.Gnome-terminal" }];
                activeWindow.mockResolvedValue(firefoxFront);
                const out = await run("linux", "wmctrl", wmctrl, "Text Editor");
                expect(out.success).toBe(false);
                expect(out.error).toMatch(/could not bring "Text Editor" to the front/);
                expect(click).not.toHaveBeenCalled();
            });

            it.each([
                ["Terminal", { app: "kitty", title: "me@box: ~" }, "kitty.kitty"],
                ["Files", { app: "pcmanfm", title: "Downloads" }, "pcmanfm.Pcmanfm"],
            ])("X11: %s asked, %j in front, no app named so installed, is clicked", async (app, w, cls) => {
                process.env.XDG_DATA_DIRS = join(share, "nothing-here");
                x11 = [{ title: w.title, cls }, firefox];
                activeWindow.mockResolvedValue(w);
                const out = await run("linux", "wmctrl", wmctrl, app);
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });

            it.each([
                ["Terminal", { app: "kitty", title: "me@box: ~" }, "kitty.kitty"],
                ["Text Editor", { app: "subl", title: "notes.txt - Sublime Text" }, "sublime_text.Sublime_text"],
            ])("X11: %s asked, another app of that kind (%j) in front, the named one installed, is clicked", async (app, w, cls) => {
                x11 = [{ title: w.title, cls }, firefox];
                activeWindow.mockResolvedValue(w);
                const out = await run("linux", "wmctrl", wmctrl, app);
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });

            it("X11: a name no installed app answers to stays best-effort", async () => {
                x11 = [firefox];
                activeWindow.mockResolvedValue(firefoxFront);
                const out = await run("linux", "wmctrl", wmctrl, "Notepad");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });

            it("without xdotool (front unknown) nothing but the title is activated, as before", async () => {
                x11 = [firefox, { title: "me@box: ~", cls: "gnome-terminal-server.Gnome-terminal" }];
                const out = await run("linux", "wmctrl", wmctrl, "Terminal");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
                expect(fakeExec.calls).toEqual([["-a", "Terminal"]]);
            });

            it("Wayland: wmctrl can't see native windows, so its miss stays best-effort", async () => {
                process.env.WAYLAND_DISPLAY = "wayland-0";
                activeWindow.mockResolvedValue(firefoxFront);
                const out = await run("linux", "wmctrl", wmctrl, "Text Editor");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });

            it.each([
                ["no wmctrl", () => fail({ code: "ENOENT" })],
                ["a timeout", timedOut],
            ])("%s stays best-effort", async (_why, result) => {
                activeWindow.mockResolvedValue(firefoxFront);
                const out = await run("linux", "wmctrl", result, "Text Editor");
                expect(out.success).toBe(true);
                expect(click).toHaveBeenCalled();
            });
        });
    });
});
