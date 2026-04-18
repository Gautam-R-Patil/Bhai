// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

declare module "sql.js" {
    export interface Database {
        run(sql: string, params?: unknown[]): void;
        exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
        export(): Uint8Array;
        close(): void;
    }

    interface SqlJsStatic {
        Database: new (data?: ArrayLike<number>) => Database;
    }

    export default function initSqlJs(config?: Record<string, unknown>): Promise<SqlJsStatic>;
}
