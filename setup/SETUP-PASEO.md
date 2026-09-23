# SETUP-PASEO — install the Paseo daemon + plugins from scratch (part 2/2)

> **⚠️ Two-repo system — this repo does NOT work on its own.**
> The plugins in this repo (task, plan, agent-health, om-panel, om-status, snip, lessons) render data produced by extensions in **pi-config**: task-status/goal-status/plan-control projections, the MARKERS timeline transformer, and the OM ledger. Without the pi pack, the plugins have nothing to display and the wake/task system does not work.
> **Required first:** [`SETUP-PI.md` in the pi-config repo](https://github.com/SilverKnightKMA/pi-config/blob/main/setup/SETUP-PI.md)

This guide is for an **agent** to read and execute on a clean machine — **Linux, macOS, and native Windows** (PowerShell).

## 0. Prerequisites

- Node.js ≥ 20 + npm (already installed if you just completed SETUP-PI)
- Paths by OS: Linux/macOS `~/.paseo/…` · native Windows `%USERPROFILE%\.paseo\…`

## 1. Install the Paseo CLI (includes the daemon)

```bash
npm install -g @getpaseo/cli
paseo --version
```

## 2. First-time setup

```bash
paseo onboard
```

One command performs initial setup, starts the daemon, and prints pairing instructions. Then check:

```bash
paseo status
```

## 3. Install eight plugins from this repo

```bash
paseo plugin add SilverKnightKMA/paseo-plugins:agent-health --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:om-panel --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:om-status --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:plan --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:snip --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:task --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:task-decisions --ref v1.0.57
paseo plugin add SilverKnightKMA/paseo-plugins:lessons --ref v1.0.57
```

(`--ref v1.0.57` is the tag at the time of writing; replace it with the latest tag in the repo if available. The daemon writes the registry into config itself — do **not** manually copy the `plugins` section of config from another machine: checkout paths contain a UUID unique to each machine.)

## 4. Set up config from samples

| Destination file | Sample source | Notes |
|---|---|---|
| `~/.paseo/config.json` | `setup/samples/paseo-config.json` | **MERGE, do not overwrite**: preserve the `plugins` block the daemon just wrote in step 3. The relay is ALWAYS enabled — by default it uses Paseo's official relay (`relay.paseo.sh:443`, set automatically during daemon onboarding); if you operate your own relay, replace only the two `endpoint`/`publicEndpoint` fields with your relay host |
| `~/.paseo/orchestration-preferences.json` | `setup/samples/paseo-orchestration-preferences.json` | Fill in `<PROVIDER>/<MODEL>` using the model configured in pi (ask the user; do not invent it) |

After editing config: `paseo reload`.

FILL-IN table:

| Placeholder | Source |
|---|---|
| `relay.paseo.sh:443` | Keep the default (Paseo's official relay). Replace it with `<YOUR-RELAY-HOST>:443` only when operating your own relay — do not hardcode a private host in publicly shared config |
| `<PROVIDER>/<*-MODEL>` | Model the user registered in `~/.pi/agent/models.json` (SETUP-PI section) |
| `terminalProfiles` | The sample contains four example profiles (tmux/claude/codex/opencode) — keep the CLIs actually present on the machine and add any desired profiles |

## 5. Verify

```bash
paseo plugin ls          # 8 plugins: agent-health, om-panel, om-status, plan, snip, task, task-decisions, lessons — status running
paseo status             # daemon running, config.json loads cleanly
```

Open a workspace in the Paseo app (app.paseo.sh): the **Tasks**, **Plans**, **OM Topics**, **Lessons**, and **Snip** panels must appear — completely empty panels mean pi-config is not installed (return to SETUP-PI).

## 6. FINAL STEP — give the user a join link

The system is ready when: `pi -p` replies OK (SETUP-PI step 5) + `paseo plugin ls` shows all eight running + `paseo status` is running. Then print pairing information for the user:

```bash
paseo daemon pair
```

The command prints the daemon's **QR code + join link**. The agent should present it to the user as follows:

> The daemon is ready. Open the Paseo app → **Add host** → scan the QR code or paste the link above → start using it immediately.

If the user connects from another machine through the relay, the link contains the relay's public endpoint — send that link, and the user can paste it into the app from anywhere.

## 7. Import this setup session into Paseo

The pi session running this guide does NOT automatically appear in the Paseo app (it runs from the terminal). Import it so the user can see the full setup history in the app:

```bash
# 1. Find the latest pi session ID for the current workspace
#    (session directory = slugified cwd: /home/you/workspaces/foo -> --home-you-workspaces-foo--)
ls -t ~/.pi/agent/sessions/ | head -5
# 2. In the directory matching cwd, the latest file has the form <timestamp>_<sessionId>.jsonl
SESSION_ID=$(basename "$(ls -t <session-directory>/*.jsonl | head -1)" | sed 's/.*_//; s/\.jsonl//')
# 3. Import (verified: creates an agent entry visible in the app; running twice is safe — the daemon rejects duplicates)
paseo import "$SESSION_ID" --provider pi
```

Tell the user: *"The setup session has been imported — open the Paseo app to see the complete installation process as a normal agent."* If the wrong session is imported, clean it up with `paseo archive <agentId>`.

### Bulk import / other providers (optional)

**Subagent principle (user directive 2026-09-19): an unimported subagent MUST
be imported and then archived immediately — do NOT omit it.** Current subagents
are NEVER missed: `spawn_subagent` always goes through `paseo_create_agent`, so
the child is registered live with `subagent.role`/`subagent.parent` labels at spawn.
A subagent session remains only on disk when it comes from the old direct-spawn era
(pre-MCP): the FIRST user message is a role prompt (for example, `"You are a research
specialist..."`) or contains the delimiter `\n---\nTASK:\n`. Handle it by importing
with `--label subagent.role=<role>`, then ARCHIVE IMMEDIATELY through MCP
`paseo_archive_agent` so it does not appear in the main list (CLI `paseo archive`
cannot reach a closed agent — the "Agent not found" error is verified). Verified:
106 old researchers imported + labeled + archived, 106/106.

Use the same command for every provider enabled in the daemon — change only `--provider` (pi, omp, codex, opencode, copilot, claude…) and the provider-specific session file source. The daemon rejects duplicate imports ("already imported"), so the loop is safe. Default: **every session except OM workers** (`.memory-*` directories — internal observational-memory sessions whose import prompts for an interactive fork):

```bash
# Step 1 — build the queue offline: each line is "provider<TAB>sessionId<TAB>cwd"
# (read cwd from the JSONL itself — REQUIRED: for a session from another workspace,
#  omitting --cwd makes the daemon ask "Fork this session...?" interactively and abort in the background)
python3 - <<'PY'
import glob, os, re, json
from collections import Counter
# EXCLUDE judge/one-shot — HIGHEST-QUALITY SIGNAL (pi-config v1.4.101+): every judge spawn
# WRITES one registry line to ~/.pi/agent/judge-sessions.jsonl {ts,cwd,path} and pins the
# session to the --judge-- subdirectory. The filter reads the registry + excludes that entire
# subdirectory; do NOT infer from content. The six-record fingerprint below is ONLY a fallback
# for judges created BEFORE v1.4.101 (old machines without the registry).
REG = os.path.expanduser('~/.pi/agent/judge-sessions.jsonl')
judge_paths = set()
try:
    for line in open(REG):
        try: judge_paths.add(json.loads(line)['path'])
        except: pass
except FileNotFoundError: pass
ONE_SHOT = {'session':1,'model_change':1,'thinking_level_change':1,'message':2,'custom_message':1}
# Broader variant (2026-09-19): judge verifiers + disposable `pi -p` probes also have the core
# {session:1, model_change:1, thinking_level_change:1, message:2} WITHOUT
# custom_message (11 judge verifiers + 12 pi/omp probes missed the old rule)
def is_one_shot(f):
    c = Counter()
    with open(f) as fh:
        for line in fh:
            try: c[json.loads(line).get('type')] += 1
            except: return False
    d = dict(c)
    if set(d) - {'session','model_change','thinking_level_change','message','custom_message'}: return False
    return (d.get('session')==1 and d.get('model_change')==1
            and d.get('thinking_level_change')==1 and d.get('message')==2
            and d.get('custom_message',0) in (0,1))
q = []
for f in glob.glob(os.path.expanduser('~/.pi/agent/sessions/*/*.jsonl')):
    if '.memory-' in f: continue          # exclude OM workers
    if '/--judge--/' in f or f in judge_paths: continue   # exclude judges (registry v1.4.101+)
    if is_one_shot(f): continue           # fallback: old pre-v1.4.101 judges
    sid = re.sub(r'.*_','',os.path.basename(f)).replace('.jsonl','')
    head = open(f,'rb').read(4000).decode('utf8','ignore')
    m = re.search(r'"cwd":"([^"]*)"', head)
    q.append(f"pi\t{sid}\t{m.group(1) if m else ''}")
open(os.path.expanduser('~/bulk-import-queue.tsv'),'w').write('\n'.join(q))
PY

# Step 2 — throttled import, log to ~/ (do not use /tmp — it is lost on restart)
setsid nohup bash -c '
while IFS=$'"'"'\t'"'"' read -r PROV ID CWD; do
  paseo import "$ID" --provider "$PROV" ${CWD:+--cwd "$CWD"} 2>&1 | grep -qE "created|already" || echo "ERR $ID"
  sleep 1
done < ~/bulk-import-queue.tsv
echo BULK-DONE' > ~/bulk-import.log 2>&1 &
tail ~/bulk-import.log   # monitor
```

Note (verified on the real 2600-session store): each import is one RPC — throttle with `sleep 1` so the daemon does not freeze (a burst once broke the container); sessions whose cwd has been deleted (for example, an old `/tmp/...` test) will ERR — these can be skipped; every import appears as an active agent in the app (the long list is an accepted tradeoff; clean up with `paseo archive <agentId>`).

### Four-layer import policy — skip table (v1.0.72, finalized 2026-09-20)

General rule: **every session WITH content must go into Paseo**; only the four groups below may remain outside,
each with a structural reason + verification command (source: `learn/report-import-project-2026-09-20.md` §3b —
the 2600-session import project audited 974→995 agents on the real store):

| Layer | Group | Reason to skip | Grows automatically? | Verification |
|---|---|---|---|---|
| 1 | **OM worker** (pi, dir `.memory-*`) | Ephemeral observational-memory pipeline worker; its result has been consolidated into `.memory/` topic files — the knowledge is on disk, not in the transcript | YES — every OM turn | `ls ~/.pi/agent/sessions/ \| grep memory-` |
| 2 | **New judge** (dir `--judge--/` + registry `~/.pi/agent/judge-sessions.jsonl`) | Layer-2 one-shot done-check verifier: reads log → PASS/FAIL → exits; first-class marker since pi-config v1.4.101 | YES — every done check | `tail ~/.pi/agent/judge-sessions.jsonl` |
| 3 | **Empty Copilot row** (sqlite `~/.copilot/session-store.db`) | Zero turns throughout — a handshake/health-check byproduct, not a conversation | YES | `SELECT COUNT(*) FROM turns` per session |
| 4 | **OMP observer-review** (subdir `<ts>_<uuid>/`) | Not a session — an internal OMP artifact (`observerPlanReview/observerResultReview.jsonl`); the real omp session is the parent-level `<ts>_<uuid>.jsonl` file | YES | glob `[0-9a-f-]{36}\.jsonl` separately |

Important boundary: **do NOT skip a one-shot probe WITH content** — import + archive it as usual
(completed for all: 5 omp stubs, 6 codex, 8+19 pi). OLD judges (pre-v1.4.101) are also imported + archived; only NEW judges are skipped.

### Import gotchas learned the hard way (v1.0.72)

1. **Queue-from-files trap (the costliest lesson — 126 empty agents):** Paseo's import app picker
   filters `hasConversation` (empty sessions are hidden), but CLI import by `sessionId` does NOT.
   A queue built from a disk scan MUST filter for multi-line files / conversation content before import,
   or one-line abort/auth-crash sessions become empty agents in the list.
2. **ACP (factory-droid) import creates file shells:** Paseo opens a temporary probe session during import →
   droid eagerly persists → each run adds 1–2 ~194B `session_start`-only shells. File-count audits
   MUST filter shells (<2KB, one line) to avoid "phantom omissions." (Upstream issue skeleton:
   `learn/fd-shell-leak-issue-proposal-2026-09-20.md`.)
3. **`pi import` asks "Fork this session?" when `--cwd` differs from the original cwd** and aborts non-interactively →
   queue building must read cwd from the JSONL and recreate the original cwd with `mkdir -p` before import (applied in step 1).
4. **Import is metadata + a pointer; it does NOT copy the transcript** (`persistence.sessionId` points to the original file):
   the provider file is the real data — never delete it; deleting the original file breaks the conversation view.
5. **Codex through Paseo does not write a rollout** (only direct CLI runs do): directly run Codex
   needs import; Codex run through Paseo is already live and must not be re-imported.
6. **Archive an empty agent after a partial import:** CLI `paseo archive` cannot reach a closed agent — use MCP
   `paseo_archive_agent` (the same mechanism used to remove 126 empty fd agents + eight E2E probes on 20/09).

---

## Migrate Paseo state from an old machine (optional, not stored in the repo)

| Group | Files/directories | Required? |
|---|---|---|
| Config | `config.json`, `orchestration-preferences.json`, `daemon-keypair.json`, `server-id`, `cli-client-id`, `push-tokens.json`, `projects/`, `plugin-data/` | Recommended — preserves the daemon identity with the relay + configuration |
| Plugin checkouts | `plugins/` (15M) | No — `paseo plugin add` checks out the correct path on the new machine |
| Data | `uploads/`, `agents/` | Optional — user-uploaded files / agent history |
| Junk | `*.log`, `runtime/`, `recovery-*`, `*.bak.*`, `paseo.pid` | Leave behind |

Note: merge the old `config.json` into the new machine as described in step 4 (preserve the new plugin registry; do not copy old UUID paths).
