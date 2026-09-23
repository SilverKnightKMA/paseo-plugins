---
status: accepted
date: 2026-09-24
deciders: user, main agent
---
# ADR 0001 — Adopt MADR-lite decision records in paseo-plugins

## Context
Same driver as pi-config ADR 0001 (see that record): no durable decision log; user asked 2026-09-24 for a standard with workflow validation to stop fabricated records.

## Decision
Adopt the same MADR-lite system in this repo: docs/decisions/NNNN-slug.md, MADR 3.0 field set (adr.github.io/madr), stdlib adr-check.py + adr-check.yml validating structure AND requiring an Evidence ref per record. No backfill — records start today, real decisions only.

## Consequences
Plugin-level decisions (architecture, API breaks, doctrine calls) get checkable records; CI fails un-evidenced ones. This repo also gets its own BACKLOG.md so pending items stop living in pi-config with tags.

## Evidence
Task #288; pi-config ADR 0001 same date; user build order 2026-09-24 ("284-288 và 1 nhiệm vụ chưa vào task thực hiện đi").
