#!/usr/bin/env python3
"""check-shared-ui.py — ép 2 bản ui.tsx phải byte-identical.

Daemon checkout từng plugin một (git source:plugin/path) nên om-status và
om-panel không thể import chéo file runtime; bộ UI dùng chung được ship như
2 bản copy. Script này (được CI chạy mỗi PR) fail khi ai sửa 1 bản mà quên
bản kia — chỉnh thì phải copy sang trong cùng commit.
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
        print("FAIL: thiếu ui.tsx —", [str(p) for p in FILES if not p.exists()])
        return 1
    hashes = {p: digest(p) for p in FILES}
    if len(set(hashes.values())) != 1:
        for p, h in hashes.items():
            print(f"{p.relative_to(ROOT)}: {h}")
        print("FAIL: om-status/ui.tsx và om-panel/ui.tsx lệch nhau — copy bản chuẩn sang bản kia trong cùng commit.")
        return 1
    print(f"OK: ui.tsx đồng bộ ({list(hashes.values())[0][:12]}…)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
