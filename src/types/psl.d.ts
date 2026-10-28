// © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// psl ships types, but its package.json "exports" hides them from NodeNext resolution.
declare module "psl" {
    const psl: {
        /** The registrable domain ("github.com" for "a.github.com"); null for a public suffix ("github.io"). */
        get(domain: string): string | null;
    };
    export default psl;
}
