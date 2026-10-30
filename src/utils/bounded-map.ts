// Copyright © 2024-2026 XAGI Labs Private Limited. All rights reserved.
// This software is proprietary. Copying or reuse is prohibited.
// See LICENSE.md for details.

/** Set `key` as the most recent entry and drop the least recent ones past `max` (an LRU on Map order). */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value as K);
}
