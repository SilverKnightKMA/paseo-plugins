#!/usr/bin/env python3
"""Pin MARKERS.md live-marker contract to agent-health consumer sites.
Run from the paseo-plugins root: python3 check-markers.py

v2.1 (2026-09-13): the old consumer (om-timeline/markers.ts) was removed
2026-09-04 (2c03477); the live consumer is the agent-health timeline
transformer. This check enforces LIVE markers only — deprecated display
markers ("> om: ", "> zw ⚠ ") have no consumer by design and are skipped.
"""
import re, sys, pathlib

root = pathlib.Path(__file__).parent
spec = (root / "MARKERS.md").read_text(encoding="utf-8")
doc = re.findall(r"Line prefix \(exact\)\s*\|\s*`([^`]+)`", spec)

consumer = (root / "agent-health" / "index.client.tsx").read_text(encoding="utf-8")

# prefix -> literal anchor that must exist in the consumer source
LIVE = {
    "[auto-report] ": '"auto-report"',
    "[channel-nack] ": '"channel-nack"',
    '<machine-notice kind="pool-notice">': '<machine-notice kind="',
}
DEPRECATED = {"> om: ", "> zw ⚠ "}

fail = False
for pfx, anchor in LIVE.items():
    if pfx not in doc:
        print(f"FAIL: live prefix {pfx!r} not documented in vendored MARKERS.md"); fail = True
    elif anchor not in consumer:
        print(f"FAIL: live prefix {pfx!r} has no consumer anchor in agent-health/index.client.tsx"); fail = True
for pfx in DEPRECATED:
    if pfx not in doc:
        print(f"FAIL: deprecated prefix {pfx!r} missing from MARKERS.md (history-render contract)"); fail = True

print("markers: OK" if not fail else "markers: DRIFT — update both sides per MARKERS.md rule 4")
sys.exit(1 if fail else 0)
