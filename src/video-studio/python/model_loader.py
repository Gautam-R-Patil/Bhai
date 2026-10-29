#!/usr/bin/env python3
# Copyright © 2024-2026 TRUSCOR Private Limited. All rights reserved.
# This software is proprietary. Copying or reuse is prohibited.
# See LICENSE.md for details.
"""
model_loader.py — On-demand model downloader sidecar for Bhai Video Studio.

Usage:
    python model_loader.py <model_name> <dest_dir>

Supported models:
    birefnet   — ZhengPeng7/BiRefNet via Hugging Face Hub snapshot_download

On success: writes <dest_dir>/.ready with an ISO 8601 timestamp and exits 0.
On failure: writes error message to stderr and exits 1.
"""

import datetime
import pathlib
import sys


SUPPORTED_MODELS: dict[str, str] = {
    "birefnet": "ZhengPeng7/BiRefNet",
}


def download_birefnet(dest_dir: pathlib.Path) -> None:
    """Download BiRefNet weights via huggingface_hub.snapshot_download."""
    from huggingface_hub import snapshot_download

    repo_id = SUPPORTED_MODELS["birefnet"]
    print(f"[model_loader] Downloading {repo_id} → {dest_dir}", flush=True)
    snapshot_download(repo_id=repo_id, local_dir=str(dest_dir))
    print(f"[model_loader] Download complete: {repo_id}", flush=True)


DOWNLOADERS = {
    "birefnet": download_birefnet,
}


def main() -> None:
    if len(sys.argv) != 3:
        print(
            "Usage: model_loader.py <model_name> <dest_dir>",
            file=sys.stderr,
        )
        sys.exit(1)

    model_name = sys.argv[1]
    dest_dir = pathlib.Path(sys.argv[2])

    if model_name not in DOWNLOADERS:
        print(f"Unknown model: {model_name}", file=sys.stderr)
        sys.exit(1)

    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        DOWNLOADERS[model_name](dest_dir)
        ready_marker = dest_dir / ".ready"
        ready_marker.write_text(
            datetime.datetime.now(datetime.timezone.utc).isoformat(),
            encoding="utf-8",
        )
        print(f"[model_loader] Wrote ready marker: {ready_marker}", flush=True)
    except Exception as exc:  # noqa: BLE001
        print(f"[model_loader] ERROR downloading {model_name}: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
