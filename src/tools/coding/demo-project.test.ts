// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { announcedUrl, detect } from "./demo-project.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "bhai-demo-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function project(name: string, files: Record<string, string>): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
    return dir;
}

describe("demo_project detection", () => {
    it("runs Django and Flask apps from requirements.txt", () => {
        const django = detect(project("dj", { "requirements.txt": "django\n", "manage.py": "" }));
        expect(django.args).toEqual(["manage.py", "runserver", "8000"]);
        const flask = detect(project("fl", { "requirements.txt": "Flask==3.0\n", "app.py": "" }));
        expect(flask.args.slice(0, 3)).toEqual(["-m", "flask", "--app"]);
        const asgi = detect(project("fa", { "requirements.txt": "fastapi\nuvicorn\n", "app.py": "" }));
        expect(asgi.args.slice(0, 2)).toEqual(["-m", "uvicorn"]);
    });

    it("reads the port the dev server announced", () => {
        expect(announcedUrl("  \u001b[32m➜\u001b[39m  Local:   http://localhost:\u001b[1m5174\u001b[22m/")).toBe(
            "http://localhost:5174",
        );
        expect(announcedUrl("Starting development server at http://127.0.0.1:8000/")).toBe("http://localhost:8000");
        expect(announcedUrl("compiling...")).toBeUndefined();
    });
});
