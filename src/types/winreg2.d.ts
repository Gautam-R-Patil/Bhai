// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

declare module "winreg2" {
    interface WinregOptions {
        hive?: string;
        key: string;
        host?: string;
        arch?: "x86" | "x64";
    }

    interface RegistryItem {
        host: string;
        hive: string;
        key: string;
        name: string;
        type: string;
        value: string;
    }

    interface Winreg {
        createAsync(): Promise<void>;
        setAsync(name: string, type: string, value: string): Promise<void>;
        getAsync(name: string): Promise<RegistryItem>;
        valuesAsync(): Promise<RegistryItem[]>;
        keysAsync(): Promise<Winreg[]>;
        removeAsync(name: string): Promise<void>;
        destroyAsync(): Promise<void>;
    }

    interface WinregConstructor {
        new (options: WinregOptions): Winreg;
        readonly HKCU: string;
        readonly HKLM: string;
        readonly HKCR: string;
        readonly HKU: string;
        readonly HKCC: string;
        readonly REG_SZ: string;
        readonly REG_DWORD: string;
        readonly REG_QWORD: string;
        readonly REG_BINARY: string;
        readonly REG_EXPAND_SZ: string;
        readonly REG_MULTI_SZ: string;
    }

    const Winreg: WinregConstructor;
    export = Winreg;
}
