#!/usr/bin/env python3
"""Ensure paseo-plugins/markers.ts stays byte-compatible with vendored MARKERS.md.
Run from the paseo-plugins root: python3 check-markers.py"""
import re, sys, pathlib

spec = pathlib.Path(__file__).with_name("MARKERS.md").read_text(encoding="utf-8")
doc = re.findall(r"Line prefix \(exact\)\s*\|\s*`([^`]+)`", spec)
code = (pathlib.Path(__file__).parent / "om-timeline" / "markers.ts").read_text(encoding="utf-8")
declared = re.findall(r'\["([a-z-]+)", "([^"]+)"\]', code)

fail = False
for variant, prefix in declared:
    if prefix not in doc:
        print(f"FAIL: markers.ts prefix {prefix!r} ({variant}) not documented in MARKERS.md"); fail = True
for p in doc:
    if not any(p == d[1] for d in declared):
        print(f"FAIL: MARKERS.md prefix {p!r} missing from markers.ts PREFIXES"); fail = True
if len(doc) != len(declared):
    print(f"FAIL: count drift — MARKERS.md {len(doc)} vs markers.ts {len(declared)}"); fail = True

print("markers: OK" if not fail else "markers: DRIFT — update both sides per MARKERS.md rule 4")
sys.exit(1 if fail else 0)
