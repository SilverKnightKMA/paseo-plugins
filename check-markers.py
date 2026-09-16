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

# prefix -> (consumer file, literal anchor that must exist in that source)
LIVE = {
    "[auto-report] ": ("agent-health/index.client.tsx", '"auto-report"'),
    "[channel-nack] ": ("agent-health/index.client.tsx", '"channel-nack"'),
    '<machine-notice kind="pool-notice">': ("agent-health/index.client.tsx", '<machine-notice kind="'),
    "Lessons from past sessions": ("lessons/shared/parser.ts", 'LESSONS_PREFIX = "Lessons from past sessions"'),
}
DEPRECATED = {"> om: ", "> zw ⚠ "}

fail = False
for pfx, (consumer_file, anchor) in LIVE.items():
    if pfx not in doc:
        print(f"FAIL: live prefix {pfx!r} not documented in vendored MARKERS.md"); fail = True
    else:
        src = (root / consumer_file).read_text(encoding="utf-8")
        if anchor not in src:
            print(f"FAIL: live prefix {pfx!r} has no consumer anchor in {consumer_file}"); fail = True
for pfx in DEPRECATED:
    if pfx not in doc:
        print(f"FAIL: deprecated prefix {pfx!r} missing from MARKERS.md (history-render contract)"); fail = True

print("markers: OK" if not fail else "markers: DRIFT — update both sides per MARKERS.md rule 4")
sys.exit(1 if fail else 0)
