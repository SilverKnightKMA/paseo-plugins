#!/usr/bin/env python3
"""check-shared-ui.py — enforce the two ui.tsx copies stay byte-identical.

The daemon checks each plugin out separately (git source:plugin/path), so
om-status and om-panel cannot cross-import runtime files; the shared UI kit
ships as two copies. This script (run by CI on every PR) fails when someone
edits one copy and forgets the other — always copy over in the same commit.
"""
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILES = [ROOT / "om-status" / "ui.tsx", ROOT / "om-panel" / "ui.tsx"]


def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    if not all(p.exists() for p in FILES):
        print("FAIL: ui.tsx missing —", [str(p) for p in FILES if not p.exists()])
        return 1
    hashes = {p: digest(p) for p in FILES}
    if len(set(hashes.values())) != 1:
        for p, h in hashes.items():
            print(f"{p.relative_to(ROOT)}: {h}")
        print("FAIL: om-status/ui.tsx and om-panel/ui.tsx differ — copy the canonical one over in the same commit.")
        return 1
    print(f"OK: ui.tsx in sync ({list(hashes.values())[0][:12]}...)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
