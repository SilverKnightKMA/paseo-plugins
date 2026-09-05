#!/usr/bin/env python3
"""check-shared-ui.py — enforce the duplicated shared files stay byte-identical.

The daemon checks each plugin out separately (git source:plugin/path), so
plugins cannot cross-import runtime files; the shared UI kit (ui.tsx) and the
session-title cache (titles.ts) ship as one copy per plugin. This script (run
by CI on every PR) fails when someone edits one copy and forgets the others —
always copy over in the same commit.
"""
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FILES = [ROOT / "om-status" / "ui.tsx", ROOT / "om-panel" / "ui.tsx", ROOT / "snip" / "ui.tsx"]
TITLE_FILES = [ROOT / "om-status" / "titles.ts", ROOT / "om-panel" / "titles.ts", ROOT / "snip" / "titles.ts"]


def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    for label, files in (("ui.tsx", FILES), ("titles.ts", TITLE_FILES)):
        if not all(p.exists() for p in files):
            print(f"FAIL: {label} missing —", [str(p) for p in files if not p.exists()])
            return 1
        hashes = {p: digest(p) for p in files}
        if len(set(hashes.values())) != 1:
            for p, h in hashes.items():
                print(f"{p.relative_to(ROOT)}: {h}")
            print(f"FAIL: {label} copies differ — copy the canonical one over in the same commit.")
            return 1
        print(f"OK: {label} in sync ({list(hashes.values())[0][:12]}...)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
