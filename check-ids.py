#!/usr/bin/env python3
"""Preflight: validate plugin ids against BOTH validators.

Daemon-side (RPC method names): ^[a-z][a-z0-9._-]*$
Client-side (panel/command ids): ^[a-z][a-z0-9-]*$   (no dots!)
Daemon-side green does NOT imply client-side green - run before reload.
"""
import re, glob, sys

CLIENT_RE = re.compile(r"^[a-z][a-z0-9-]*$")
RPC_RE = re.compile(r"^[a-z][a-z0-9._-]*$")
bad = 0
for f in glob.glob("*/index.ts") + glob.glob("*/rpc.ts"):
    src = open(f).read()
    for kind in ("addCommandCenterItem", "addWorkspacePanel", "addSidebarItem"):
        for m in re.finditer(kind + r"\(\{[\s\S]{0,160}?id:\s*\"([^\"]+)\"", src):
            if not CLIENT_RE.match(m.group(1)):
                print(f"BAD client id: {f} ({kind}): {m.group(1)}"); bad += 1
    for m in re.finditer(r'name:\s*"([a-z][a-z0-9._-]+\.[a-z][a-z0-9._-]+)"', src):
        if not RPC_RE.match(m.group(1)):
            print(f"BAD rpc name: {f}: {m.group(1)}"); bad += 1
sys.exit(1 if bad else print("preflight: OK"))
