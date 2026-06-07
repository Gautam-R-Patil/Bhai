// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

// Ambient declaration mirroring the shape winreg2 actually ships (ESM named
// exports, Promise methods without the `Async` suffix, Hive/RegType enums —
// NOT the old `winreg` default-export + static-constant API).
declare module "winreg2" {
    export enum Hive {
        HKLM = "HKEY_LOCAL_MACHINE",
        HKCU = "HKEY_CURRENT_USER",
        HKCR = "HKEY_CLASSES_ROOT",
        HKU = "HKEY_USERS",
        HKCC = "HKEY_CURRENT_CONFIG",
    }

    export enum Arch {
        x86 = "x86",
        x64 = "x64",
    }

    export enum RegType {
        REG_SZ = "REG_SZ",
        REG_MULTI_SZ = "REG_MULTI_SZ",
        REG_EXPAND_SZ = "REG_EXPAND_SZ",
        REG_DWORD = "REG_DWORD",
        REG_QWORD = "REG_QWORD",
        REG_BINARY = "REG_BINARY",
        REG_NONE = "REG_NONE",
    }

    export interface RegistryItem {
        readonly host: string;
        readonly hive: string;
        readonly key: string;
        readonly name: string;
        readonly type: RegType;
        readonly value: string;
        readonly arch: Arch | undefined;
    }

    export interface RegistryOptions {
        host?: string;
        hive?: Hive;
        key: string;
        arch?: Arch;
    }

    export class Registry {
        constructor(options: RegistryOptions);
        readonly host: string;
        readonly hive: Hive;
        readonly key: string;
        readonly path: string;
        readonly arch: Arch | undefined;
        get parent(): Registry;
        static DEFAULT_VALUE: string;
        static REG_PATH: string;
        values(): Promise<RegistryItem[]>;
        keys(): Promise<Registry[]>;
        get(name: string): Promise<RegistryItem>;
        set(name: string, type: RegType, value: string): Promise<void>;
        remove(name: string): Promise<void>;
        clear(): Promise<void>;
        destroy(): Promise<void>;
        create(): Promise<void>;
        keyExists(): Promise<boolean>;
        valueExists(name: string): Promise<boolean>;
    }
}
