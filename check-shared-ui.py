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
FILES = [ROOT / "om-status" / "client" / "ui.tsx", ROOT / "om-panel" / "client" / "ui.tsx", ROOT / "snip" / "client" / "ui.tsx", ROOT / "task" / "client" / "ui.tsx", ROOT / "plan" / "client" / "ui.tsx"]
TITLE_FILES = [ROOT / "om-status" / "server" / "titles.ts", ROOT / "om-panel" / "server" / "titles.ts", ROOT / "snip" / "server" / "titles.ts", ROOT / "task" / "server" / "titles.ts", ROOT / "plan" / "server" / "titles.ts"]
FILTER_FILES = [ROOT / "om-status" / "server" / "session-filter.ts", ROOT / "om-panel" / "server" / "session-filter.ts", ROOT / "snip" / "server" / "session-filter.ts", ROOT / "task" / "server" / "session-filter.ts", ROOT / "plan" / "server" / "session-filter.ts"]
LIVE_FILES = [ROOT / "om-status" / "client" / "use-live.ts", ROOT / "om-panel" / "client" / "use-live.ts", ROOT / "snip" / "client" / "use-live.ts", ROOT / "task" / "client" / "use-live.ts", ROOT / "plan" / "client" / "use-live.ts", ROOT / "lessons" / "client" / "use-live.ts"]


def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def main() -> int:
    for label, files in (("ui.tsx", FILES), ("titles.ts", TITLE_FILES), ("session-filter.ts", FILTER_FILES), ("use-live.ts", LIVE_FILES)):
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
