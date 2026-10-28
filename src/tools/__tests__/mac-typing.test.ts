// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { MAC_TYPE_JXA, shouldRealKeystroke } from "../os-computer-action.js";

describe("macOS typing", () => {
    it("types short ASCII as keystrokes, pastes the rest", () => {
        expect(shouldRealKeystroke("hello world 42")).toBe(true);
        expect(shouldRealKeystroke("line\nbreak")).toBe(false);
        expect(shouldRealKeystroke("नमस्ते")).toBe(false);
        expect(shouldRealKeystroke("x".repeat(201))).toBe(false);
    });

    // Same script on a private pasteboard with the Cmd+V removed: the user's
    // clipboard and apps are never touched.
    it.skipIf(process.platform !== "darwin")("paste restores every pasteboard item and type", () => {
        const name = `bhai-test-${process.pid}`;
        const script = MAC_TYPE_JXA.replace("$.NSPasteboard.generalPasteboard", `$.NSPasteboard.pasteboardWithName($('${name}'))`).replace(
            "se.keystroke('v', { using: 'command down' });",
            "",
        );
        expect(script).not.toContain("generalPasteboard");
        expect(script).not.toContain("command down");
        const jxa = (body: string) => execFileSync("osascript", ["-l", "JavaScript", "-e", `ObjC.import('AppKit'); const pb = $.NSPasteboard.pasteboardWithName($('${name}')); ${body}`]).toString().trim();

        jxa(`pb.clearContents; const it = $.NSPasteboardItem.alloc.init;
             it.setStringForType($('user text'), $.NSPasteboardTypeString);
             it.setDataForType($('PNGBYTES').dataUsingEncoding($.NSUTF8StringEncoding), $('public.png'));
             pb.writeObjects($([it])); 'ok'`);
        execFileSync("osascript", ["-l", "JavaScript", "-e", script, "paste"], { input: "secret 551902" });
        const after = jxa(`const it = pb.pasteboardItems.objectAtIndex(0);
             JSON.stringify({ n: Number(pb.pasteboardItems.count), s: it.stringForType($.NSPasteboardTypeString).js,
               png: Number(it.dataForType($('public.png')).length), types: ObjC.deepUnwrap(it.types) })`);
        jxa("pb.releaseGlobally; 'ok'");
        const r = JSON.parse(after);
        expect(r).toMatchObject({ n: 1, s: "user text", png: 8 });
        expect(r.types).not.toContain("org.nspasteboard.ConcealedType");
    });
});
