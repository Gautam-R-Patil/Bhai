#!/usr/bin/env python3
# Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
#
# Dumps the Linux AT-SPI accessibility tree to JSON, schema-compatible with scripts/dump_ax.swift.
#
# Usage:
#   python3 dump_atspi.py [--pid PID] [--depth N] [--bbox-only]
#
# Requires: python3-pyatspi (apt: python3-pyatspi).
# Electron/Chromium apps need --force-renderer-accessibility to populate the tree.
#
# On error: prints "error|<reason>" and exits 1.
import argparse
import json
import sys


def fail(reason: str) -> None:
    sys.stdout.write(f"error|{reason}\n")
    sys.exit(1)


try:
    import gi  # type: ignore

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi  # type: ignore
except Exception as e:
    fail(f"atspi_not_available:{e}")
    raise  # for type-checker; unreachable


def slice_value(s, mx: int = 200):
    if s is None:
        return None
    s = str(s)
    return s if len(s) <= mx else s[:mx]


def walk(node, depth: int, max_depth: int, bbox_only: bool):
    if depth > max_depth or node is None:
        return None
    try:
        ext = node.get_extents(Atspi.CoordType.SCREEN)
    except Exception:
        ext = None
    try:
        role = node.get_role_name()
    except Exception:
        role = None
    try:
        label = node.get_name()
    except Exception:
        label = None
    # Collect states FIRST so the password-field check can gate value extraction.
    states = set()
    try:
        for s in node.get_state_set().get_states():
            states.add(s.value_nick)
    except Exception:
        pass
    is_secure = "protected" in states  # GTK/Qt mark password fields with STATE_PROTECTED
    value = None
    if not bbox_only and not is_secure:
        try:
            ti = node.get_text_iface()
            if ti:
                # SECURITY/PERF: bound the AT-SPI text fetch — never pull more than 300 chars
                # over the bus even if the source document is megabytes.
                char_count = ti.get_character_count()
                end = min(300, char_count) if char_count > 0 else 0
                if end > 0:
                    value = slice_value(ti.get_text(0, end))
        except Exception:
            pass
    elif is_secure:
        value = "[secure]"

    out = {
        "role": role,
        "subrole": None,
        "label": slice_value(label),
        "value": value,
        "x": ext.x if ext else 0,
        "y": ext.y if ext else 0,
        "w": ext.width if ext else 0,
        "h": ext.height if ext else 0,
        "focusable": "focusable" in states,
        "enabled": "enabled" in states,
        "children": [],
    }
    try:
        for i in range(node.get_child_count()):
            c = node.get_child_at_index(i)
            if c:
                k = walk(c, depth + 1, max_depth, bbox_only)
                if k:
                    out["children"].append(k)
    except Exception:
        pass
    return out


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, default=0)
    parser.add_argument("--depth", type=int, default=20)  # raised from 12
    parser.add_argument("--bbox-only", action="store_true")
    args = parser.parse_args()

    max_depth = max(1, min(30, args.depth))

    try:
        desktop = Atspi.get_desktop(0)
    except Exception as e:
        fail(f"desktop_query_failed:{e}")
        return

    target = None
    app_name = "unknown"
    picked_pid = 0
    try:
        for i in range(desktop.get_child_count()):
            app = desktop.get_child_at_index(i)
            try:
                this_pid = app.get_process_id()
            except Exception:
                this_pid = 0
            if args.pid and this_pid != args.pid:
                continue
            target = app
            picked_pid = this_pid
            try:
                app_name = app.get_name() or "unknown"
            except Exception:
                pass
            if args.pid:
                break
            # No pid filter: pick the first app that has windows (rough "frontmost" proxy)
            if app.get_child_count() > 0:
                break
    except Exception as e:
        fail(f"app_query_failed:{e}")
        return

    if not target:
        fail("no_app_found")
        return

    root = walk(target, 0, max_depth, args.bbox_only)
    if root is None:
        fail("walk_failed")
        return

    output = {
        "app": app_name,
        "pid": picked_pid,
        "root": root,
        "trusted": True,
        "depth": max_depth,
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
