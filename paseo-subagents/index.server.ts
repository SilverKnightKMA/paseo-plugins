/**
 * paseo-subagents — scoped child->parent reply door for Paseo.
 *
 * Children created with env PASEO_PARENT_AGENT_ID (= "this is a subagent of
 * X", carried by the `paseo run --env` / create_agent_request protocol path)
 * lose the daemon's full MCP catalog and gain exactly one tool:
 * reply_to_parent(prompt). The door resolves the caller to its parent by the
 * opaque token minted at create; no agentId is addressable from the child.
 *
 * NOTE the plugin contract: the default export must be SYNCHRONOUS and return
 * a cleanup function (the plugin process checks the return type before any
 * await — an async contribution is rejected at load time).
 *
 * Env (read once at plugin start):
 *   SUBAGENT_REPLY_ALLOW_FULL=1  — opt in to spawning children with mode=full
 *                                  (fail-closed floor refuses it otherwise)
 */
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PluginCleanup } from "@getpaseo/plugin";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { TokenRegistry } from "./server/tokens.js";
import { listenReplyServer, type ReplyServerHandle, type SpawnFn, type SpawnPoolFn, type CallerCaps, type SpawnArgs, type AskFn, type AnswerFn } from "./server/mcp-server.js";
import { registerSubagentReplyHook, registerEnvDoorHook, PARENT_ENV, MAIN_MCP_KEY } from "./server/hooks.js";
import { canAnswer, makeQuestionId, type PendingQuestion } from "./server/ask.js";
import { composeInitialPrompt, resolveRole, doorToolPolicy, type PluginSettings } from "./server/roles.js";
import {
  aggregatePoolReport,
  allTerminal,
  makePoolId,
  POOL_MAX_AGE_MS,
  scheduleBatches,
} from "./server/pool";
import {
  readAgentRecords,
  toIdleChildren,
  shouldRemindIdleArchive,
  reminderArmed,
  DEFAULT_REMIND_MINUTES,
} from "./server/idle-archive.js";
import { isTerminal, lastAssistantText, autoReportEnvelope, type WatchedChild } from "./server/auto-report.js";
import { doorGrantMessage, doorUrlForMain, envDoorUrlForMain, GrantLedger, readMainDoorState, shouldGrant } from "./server/grant.js";
import { GrantStore, pluginDataDir, writeDoorState } from "./server/door-state.js";
import { adoptFromRecord } from "./server/adopt.js";

/** Absolute maximum depth (spec section 6): main=0 → child=1 → grandchild=2. */
const MAX_DEPTH = 2;

/** Structural slice of the SDK API the door needs (avoids importing
 *  @getpaseo/client, which is not a plugin-SDK specifier). */
interface PaseoSendSlice {
  agents: {
    ref(id: string): {
      send(text: string): Promise<void>;
      /** #225 auto-report: read a child's timeline (assistant_message) provider-agnostically. */
      timeline?: { refetch(): Promise<{ entries?: { item?: unknown }[] }> };
    };
    create(options: {
      config: {
        provider: string;
        title?: string;
        mcpServers?: Record<string, unknown>;
        modeId?: string;
        /** #225: door tool pre-approval (claude allowedTools / codex enabled_tools). */
        toolPolicy?: { preapproved: { kind: "mcp"; server: string; tool: string }[] };
      };
      parent?: string | { id: string };
      labels?: Record<string, string>;
      prompt?: string;
      env?: Record<string, string>;
      cwd: string;
    }): Promise<{ id: string }>;
  };
}

export default function contribute(server: PluginServerContext): PluginCleanup {
  const registry = new TokenRegistry();
  const allowFull = process.env.SUBAGENT_REPLY_ALLOW_FULL === "1";

  // The plugin server context does not hand us a PaseoApi directly; hook and
  // event contexts do. Delivery can only happen after some lifecycle context
  // has been observed (a child must have been created to call the door), so
  // capturing lazily is safe by ordering.
  let paseoApi: PaseoSendSlice | null = null;
  let apiCapturedLogged = false;
  const capturePaseo = (api: PaseoSendSlice, via = "unknown"): void => {
    const first = paseoApi === null;
    paseoApi ??= api;
    if (first && !apiCapturedLogged) {
      apiCapturedLogged = true;
      console.log(`[paseo-subagents] paseo api captured via ${via}`);
    }
  };

  // Repo wins (spec v6): settings.json in the plugin repo is the source of truth,
  // loaded once at startup. PASEO_SUBAGENTS_SETTINGS provides an alternate path if needed.
  const settings: PluginSettings = (() => {
    const p =
      process.env.PASEO_SUBAGENTS_SETTINGS ??
      join(homedir(), "workspaces", "paseo-plugins", "paseo-subagents", "settings.json");
    try {
      if (!existsSync(p)) return {};
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as PluginSettings;
      console.log(`[paseo-subagents] settings loaded from ${p}`);
      return parsed;
    } catch (err) {
      console.log(`[paseo-subagents] settings load failed (${err instanceof Error ? err.message : String(err)}) — using defaults`);
      return {};
    }
  })();

  // ── Idle-archive reminder (#141 / plan step 7) ─────────────────────────
  // Daemon-side port of #129: scan disk records every 60s and remind the parent
  // through the proper delivery channel when every child (subagent.parent label)
  // has been idle for at least N minutes. REMIND, do not auto-archive. 0 = disabled.
  // Track only this plugin's children to avoid duplicate reminders with pi ext,
  // which reminds its own children in the pi process.
  const remindMinutes = (() => {
    const raw = Number(process.env.PASEO_SUBAGENTS_ARCHIVE_REMIND_MINUTES);
    return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.round(raw), 1440) : DEFAULT_REMIND_MINUTES;
  })();
  const lastRemindByParent = new Map<string, number>();
  const agentsRoot = join(homedir(), ".paseo", "agents");

  const scanIdleArchive = async (): Promise<void> => {
    const api = paseoApi;
    if (!api) return; // No lifecycle context yet — wait for the next scan.
    try {
      const records = readAgentRecords(agentsRoot);
      const byId = new Map(records.map((r) => [r.id, r]));
      const parents = new Set<string>();
      for (const r of records) {
        if (r.labels?.["subagent.spawner"] !== "paseo-subagents") continue;
        const p = r.labels?.["subagent.parent"];
        // Do not remind archived parents (send would auto-unarchive and wake them).
        if (p && p !== "(main)" && !byId.get(p)?.archivedAt) parents.add(p);
      }
      for (const parent of parents) {
        const children = toIdleChildren(records, parent);
        const r = shouldRemindIdleArchive(children, Date.now(), remindMinutes);
        if (!r) continue;
        if (!reminderArmed(lastRemindByParent.get(parent), Date.now())) continue;
        lastRemindByParent.set(parent, Date.now());
        console.log(
          `[paseo-subagents] idle-archive reminder: ${children.length} children of ${parent} idle for ≥${remindMinutes}m`,
        );
        await api.agents.ref(parent).send(
          `[housekeeping] ${children.length} subagents have been idle for ≥${remindMinutes} minutes, and none are running or parked. Archive them to keep the list tidy (soft delete — sending a message to a child automatically unarchives it):\n${r.command}`,
        );
      }
    } catch (err) {
      console.log(`[paseo-subagents] idle-archive scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const idleTimer =
    remindMinutes > 0
      ? setInterval(() => {
          void scanIdleArchive();
        }, 60_000)
      : null;
  if (idleTimer) idleTimer.unref?.();
  console.log(
    `[paseo-subagents] idle-archive scanner ${remindMinutes > 0 ? `armed (${remindMinutes}m, scans every 60s)` : "disabled (0)"}`,
  );

  // #225 auto-report backstop state: children spawned by THIS process are
  // watched until terminal; children that DID deliver via reply_to_parent are
  // marked at deliver time (meta.callerAgentId) and never pinged.
  const watched = new Map<string, WatchedChild>();
  const reported = new Set<string>();

  const spawnChild = async (
    caller: CallerCaps,
    args: SpawnArgs,
    extraLabels?: Record<string, string>,
  ): Promise<{ agentId: string } | { error: string }> => {
    const api = paseoApi;
    if (!api) return { error: "paseo API not captured yet — daemon lifecycle context missing" };
    if (caller.depth >= MAX_DEPTH) {
      return { error: `depth cap: caller depth=${caller.depth}, max=${MAX_DEPTH} (spec section 6 — limits recursion)` };
    }
    const resolved = resolveRole(args.role, settings);
    if (!resolved.ok) return { error: resolved.error };
    const { role } = resolved;
    const title = args.name ?? `${args.role}: ${args.task.slice(0, 40)}`;
    const initialPrompt = composeInitialPrompt(role, args.task);

    // SpawnFn mints the child's scoped door directly (spec 4.1), without relying on
    // an environment carrier. Env values passed through SDK agents.create do not reach
    // the before(agent.create) hook (E2E 2026-09-20: child received the wrong main door).
    const parentId = caller.boundAgentId;
    if (!parentId) {
      return { error: "main door token has not been bound to agentId (agent.created has not arrived) — retry shortly" };
    }
    const port = replyServer?.port ?? null;
    if (port === null) return { error: "reply door is not listening — retry shortly" };
    const token = registry.mint(parentId, title, { depth: caller.depth + 1, canSpawn: false, role: args.role, providerModel: role.providerEntry });
    const childDoorUrl = `http://127.0.0.1:${port}/mcp?caller=${token}`;

    const labels: Record<string, string> = {
      // idle-archive: the plugin reminds only children IT spawned. Pi ext children
      // also carry subagent.parent, so omitting this label causes duplicate reminders
      // (E2E 18:03: parent cf76ad71 received reminders from both engines).
      "subagent.spawner": "paseo-subagents",
      "subagent.role": args.role,
      "subagent.depth": String(caller.depth + 1),
      "subagent.parent": parentId,
      ...(extraLabels ?? {}),
    };
    try {
      const child = await api.agents.create({
        config: {
          provider: role.providerEntry,
          modeId: role.modeId,
          title,
          // F11: non-pi providers receive the pinned thinking level. Codex maps
          // thinkingOptionId -> reasoning_effort (daemon codex adapter), Claude ->
          // adaptive-thinking effort. Pi: kể từ engine v1.4.129 strip
          // model/thinking khỏi agents/*.md, settings.json của plugin là nguồn
          // chân lý duy nhất — thread cho MỌI provider.
          ...(role.thinking ? { thinkingOptionId: role.thinking } : {}),
          mcpServers: {
            paseo: { type: "http" as const, url: childDoorUrl, alwaysLoad: true },
          },
          // #225: un-gate the door tools for providers that permission-gate MCP
          // calls (claude acceptEdits hung 71 minutes on the approval). Pi's reply
          // door is a native ungated extension tool — and the daemon rejects
          // toolPolicy for pi outright — so it gets none.
          ...doorToolPolicy(role.provider, "paseo"),
        },
        cwd: process.cwd(), // TODO(E2E): use the caller agent's cwd when the slice is extended.
        prompt: initialPrompt,
        labels,
        parent: parentId,
      });
      console.log(`[paseo-subagents] spawn_subagent: role=${args.role} -> agent ${child.id} (parent ${parentId}, depth ${caller.depth + 1}, door scoped 1 tool)`);
      // #225 auto-report backstop: watch every plugin-spawned child; if it goes
      // terminal without calling reply_to_parent, its last assistant text is
      // captured from the timeline and delivered as [child-report].
      watched.set(child.id, {
        agentId: child.id,
        parentId,
        title,
        role: args.role,
        providerModel: role.providerEntry,
        spawnedAt: Date.now(),
      });
      return { agentId: child.id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const spawnFn: SpawnFn = (caller, args) => spawnChild(caller, args);

  // ── spawn_pool (#145 / plan step 10): fan-out 2-12 children, ≤4 song song,
  // one aggregate [pool-report] envelope when every child is terminal. Pool state
  // lives in the plugin process's RAM (enough for v1 — restarting the daemon loses
  // active pools, but each child still sends its own [child-report], so no data is lost).
  const pools = new Map<
    string,
    { parentId: string; createdAt: number; childIds: string[]; titles: Map<string, string> }
  >();
  const spawnPoolFn: SpawnPoolFn = async (caller, args) => {
    const poolId = makePoolId();
    const childIds: string[] = [];
    const titles = new Map<string, string>();
    for (const batch of scheduleBatches(args.items, args.concurrency ?? 4)) {
      const results = await Promise.all(
        batch.map(async (item) => ({ item, res: await spawnChild(caller, item, { "subagent.pool": poolId }) })),
      );
      for (const { item, res } of results) {
        if ("agentId" in res) {
          childIds.push(res.agentId);
          titles.set(res.agentId, item.name ?? `${item.role}: ${item.task.slice(0, 30)}`);
        }
      }
    }
    if (childIds.length === 0) return { error: "spawn_pool: every item failed to spawn (see plugin log)" };
    pools.set(poolId, { parentId: caller.boundAgentId ?? "", createdAt: Date.now(), childIds, titles });
    console.log(`[paseo-subagents] spawn_pool ${poolId}: ${childIds.length}/${args.items.length} children (parent ${caller.boundAgentId}, concurrency ${args.concurrency ?? 4})`);
    return { poolId, spawned: childIds.length };
  };

  // Pool watcher: scan disk records every 30s; when every child is terminal
  // (idle/error/archived), send ONE aggregate [pool-report] and forget the pool.
  // Pool older than 2h → partial flush.
  const scanPools = async (): Promise<void> => {
    const api = paseoApi;
    if (!api || pools.size === 0) return;
    let records: ReturnType<typeof readAgentRecords>;
    try {
      records = readAgentRecords(agentsRoot);
    } catch {
      return; // Temporary disk error — retry on the next scan.
    }
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const [poolId, pool] of [...pools]) {
      const children = pool.childIds
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({ id: r.id, lastStatus: r.lastStatus ?? null, archivedAt: r.archivedAt ?? null }));
      const aged = Date.now() - pool.createdAt > POOL_MAX_AGE_MS;
      if (!allTerminal(children) && !aged) continue;
      if (children.length === 0) {
        pools.delete(poolId); // Records disappeared (deleted) — stop waiting.
        continue;
      }
      const text = aggregatePoolReport(poolId, children, (c) => ({
        label: pool.titles.get(c.id) ?? c.id,
        state: c.archivedAt ? "archived" : (c.lastStatus ?? "unknown"),
      })) + (aged && !allTerminal(children) ? "\n(pool exceeded 2h — partial flush; non-terminal children will send their own [child-report] separately)" : "");
      pools.delete(poolId);
      try {
        console.log(`[paseo-subagents] pool-report ${poolId} -> parent ${pool.parentId}`);
        await api.agents.ref(pool.parentId).send(text);
      } catch (err) {
        console.log(`[paseo-subagents] pool-report deliver failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  };
  // #225 auto-report backstop scan: runs on the same 30s cadence as the pool
  // watcher. For every watched child whose disk record is terminal AND that has
  // not delivered via the door: mark reported FIRST (dedupe before any await —
  // a reply arriving mid-scan must not double-send), then capture the child's
  // last assistant text from its timeline and deliver the [child-report].
  const scanAutoReport = async (): Promise<void> => {
    const api = paseoApi;
    if (!api || watched.size === 0) return;
    let records: ReturnType<typeof readAgentRecords>;
    try {
      records = readAgentRecords(agentsRoot);
    } catch {
      return; // Temporary disk error — retry on the next scan.
    }
    const byId = new Map(records.map((r) => [r.id, r]));
    for (const [childId, child] of [...watched]) {
      if (reported.has(childId)) {
        watched.delete(childId);
        continue;
      }
      const record = byId.get(childId);
      if (!record) {
        watched.delete(childId); // Record deleted — stop waiting.
        continue;
      }
      if (!isTerminal(record)) continue;
      watched.delete(childId);
      reported.add(childId);
      let finalText: string | null = null;
      try {
        const ref = api.agents.ref(childId);
        if (ref.timeline?.refetch) {
          const payload = await ref.timeline.refetch();
          finalText = lastAssistantText((payload?.entries ?? []).map((e) => e.item));
        }
      } catch (err) {
        console.log(`[paseo-subagents] auto-report timeline fetch failed (${childId.slice(0, 8)}): ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        console.log(`[paseo-subagents] auto-report: child ${childId.slice(0, 8)} terminal without reply_to_parent -> parent ${child.parentId.slice(0, 8)}`);
        await api.agents.ref(child.parentId).send(autoReportEnvelope(child, finalText));
      } catch (err) {
        console.log(`[paseo-subagents] auto-report deliver failed (${childId.slice(0, 8)}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const poolTimer = setInterval(() => {
    void scanPools();
    void scanAutoReport();
  }, 30_000);
  poolTimer.unref?.();

  // ── ask_parent / answer_child (#146 / plan step 11) — pending RAM,
  // Restarting loses pending questions (the child can ask again — fail-honest).
  const pendingQuestions = new Map<string, PendingQuestion>();
  const askFn: AskFn = async (caller, parentId, question) => {
    const api = paseoApi;
    if (!api) return { error: "paseo API not captured yet — retry later" };
    const childId = caller.boundAgentId;
    if (!childId) return { error: "door token has not been bound to agentId — retry shortly" };
    const questionId = makeQuestionId();
    try {
      await api.agents
        .ref(parentId)
        .send(`[child-question] child (${childId.slice(0, 8)}) asks: ${question}\nAnswer with the answer_child tool using questionId=${questionId}`);
      pendingQuestions.set(questionId, { questionId, childId, parentId, createdAt: Date.now() });
      console.log(`[paseo-subagents] ask_parent ${questionId}: child ${childId.slice(0, 8)} -> parent ${parentId.slice(0, 8)}`);
      return { questionId };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  const answerFn: AnswerFn = async (caller, questionId, answer) => {
    const api = paseoApi;
    if (!api) return { error: "paseo API not captured yet" };
    const pending = pendingQuestions.get(questionId);
    if (!pending) return { error: `questionId '${questionId}' does not exist (already answered or plugin restarted) — the child will ask again if needed` };
    if (!canAnswer(pending, caller.boundAgentId)) return { error: "only the question's parent may answer" };
    try {
      await api.agents.ref(pending.childId).send(`[parent-answer] ${answer}`);
      pendingQuestions.delete(questionId);
      console.log(`[paseo-subagents] answer_child ${questionId} -> con ${pending.childId.slice(0, 8)}`);
      return { delivered: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  let replyServer: ReplyServerHandle | null = null;
  listenReplyServer({
    registry,
    // spec v12 pa1 (#158 / plan 8/20): verification miss → find the disk record
    // containing the exact token and register it in RAM again. The
    // PASEO_SUBAGENTS_ADOPT=0 hatch disables this path (401 as in v1.0.69).
    adopt: (token) => adoptFromRecord(agentsRoot, token, registry) !== null,
    deliver: (parentId, title, prompt, meta) => {
      const api = paseoApi;
      if (!api) return Promise.reject(new Error("paseo API not captured yet — daemon lifecycle context missing"));
      // #225: a successful (in-flight) tool delivery counts as reported — the
      // auto-report backstop must not double-ping children that used the door.
      if (meta?.callerAgentId) {
        reported.add(meta.callerAgentId);
        watched.delete(meta.callerAgentId);
      }
      console.log(`[paseo-subagents] deliver [child-report] '${title}' -> parent ${parentId}`);
      return api.agents.ref(parentId).send(`[child-report] ${title}: ${prompt}`);
    },
    spawn: spawnFn,
    spawnPool: spawnPoolFn,
    ask: askFn,
    answer: answerFn,
  })
    .then((handle) => {
      replyServer = handle;
      try {
        const adopted = grantStore.adoptAll(registry);
        writeDoorState(doorDataDir, handle.port);
        console.log(`[paseo-subagents] door-state persisted (port ${handle.port}); ${adopted} grant token(s) adopted from grants.json (F10)`);
      } catch (err) {
        console.log(`[paseo-subagents] door-state/grants persistence unavailable: ${err instanceof Error ? err.message : String(err)}`);
      }
      console.log(
        `[paseo-subagents] listening on 127.0.0.1:${handle.port} (allowFull=${allowFull ? "1" : "0"}); ` +
          `spawn children with --env PASEO_PARENT_AGENT_ID[=id][,PASEO_CHILD_MODE=knob] to get the scoped door`,
      );
    })
    .catch((err: unknown) => {
      console.error(`[paseo-subagents] FAILED to listen: ${err instanceof Error ? err.message : String(err)}`);
    });

  const offCreated = server.on("agent.created", (event, context) => {
    capturePaseo(context.paseo);
    // The event carries only metadata (PluginHookAgent has no config). Read the
    // record file to get the injected door URL, then bind token → agentId (main
    // mints the token BEFORE it has an ID — spec 4.2).
    try {
      const id = event.agent.id;
      const agentsRoot = join(homedir(), ".paseo", "agents");
      let url: string | undefined;
      for (const ws of existsSync(agentsRoot) ? readdirSync(agentsRoot) : []) {
        const file = join(agentsRoot, ws, `${id}.json`);
        if (!existsSync(file)) continue;
        const record = JSON.parse(readFileSync(file, "utf-8")) as {
          config?: { mcpServers?: Record<string, { url?: string }> };
        };
        url = record.config?.mcpServers?.[MAIN_MCP_KEY]?.url ?? record.config?.mcpServers?.["paseo"]?.url;
        break;
      }
      if (url) {
        const token = new URL(url).searchParams.get("caller");
        if (token && registry.findByUrl(url)) {
          registry.bind(token, id);
          console.log(`[paseo-subagents] bound main door token -> agent ${id} ('${event.agent.title ?? "untitled"}')`);
        }
      } else {
        console.log(`[paseo-subagents] agent.created '${event.agent.title ?? id}': no door URL in record — skipping bind (agent was not given a door by the plugin)`);
      }
    } catch (err) {
      console.log(`[paseo-subagents] bind main door failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // The scanner needs paseoApi, but lazily capturing it through agent.created is
  // fragile: after restart, if no NEW agent is created, the scanner remains inert
  // (E2E 17:51: the reminder did not fire after the grace period). Also capture it
  // from the most common events — any agent ending any turn is enough. Unknown
  // events (names rejected by the runtime) must NOT kill the plugin, so catch each one.
  const safeOn = (name: string, fn: unknown): (() => void) => {
    try {
      const off = (server.on as unknown as (n: string, f: unknown) => () => void)(name, fn);
      return typeof off === "function" ? off : () => {};
    } catch (err) {
      console.log(`[paseo-subagents] could not register event '${name}': ${err instanceof Error ? err.message : String(err)} — skipping`);
      return () => {};
    }
  };
  // ── L1 door grant (spec v12 section 11 · #156 / plan 6/20) ─────────────
  // A main created BEFORE the plugin has no door in its record. When that main
  // ends a turn, the plugin mints a new token and sends '[door-grant] <url>' to
  // the chat. Guard: exactly once per process per agent (GrantLedger), only for
  // unarchived mains without doors. Self-heals after restart (empty RAM ledger →
  // grant again next turn). Do NOT write the record.
  const grantLedger = new GrantLedger();
  // F10 (#219): door port + grant tokens survive plugin restarts via
  // ~/.paseo/plugin-data/paseo-subagents/{door-state.json,grants.json}.
  const doorDataDir = pluginDataDir();
  const grantStore = new GrantStore(doorDataDir);
  const onTurnEnded = (event: unknown, context: { paseo?: unknown }): void => {
    if (context?.paseo) capturePaseo(context.paseo as PaseoSendSlice, "turn_ended");
    try {
      const agent = (event as { agent?: { id?: string; title?: string } } | null)?.agent;
      const id = agent?.id;
      if (!id || !grantLedger.allow(id)) return;
      const state = readMainDoorState(agentsRoot, id);
      if (!shouldGrant(state)) return; // Already has a door / child / archived / no record.
      const api = paseoApi;
      if (!api) return; // No lifecycle context yet — retry next turn.
      const grant = doorUrlForMain({ registry, getPort: () => replyServer?.port ?? null, allowFull, log: (m) => console.log(m) }, grantLedger, grantStore, id, agent.title ?? "main");
      if (!grant) return; // Door is not listening — retry next turn.
      const port = replyServer?.port;
      if (typeof port !== "number") return;
      // Notify the chat only when it carries NEW information (first mint, or the
      // port rotated since the last message) — not on every turn (F10).
      const prevPort = grantStore.entryFor(id)?.lastNotifiedPort;
      if (!grant.freshMint && prevPort === port) return;
      void api.agents
        .ref(id)
        .send(doorGrantMessage(grant.url))
        .then(() => {
          grantStore.markNotified(id, port);
          console.log(`[paseo-subagents] door grant sent -> agent ${id} (main without a door, L1, port ${port}${grant.freshMint ? ", fresh mint" : ", re-notified after rotation"})`);
        })
        .catch((err: unknown) => console.log(`[paseo-subagents] door-grant send failed (${id}): ${err instanceof Error ? err.message : String(err)}`));
    } catch (err) {
      console.log(`[paseo-subagents] door-grant check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const offTurnEnded = safeOn("agent.turn_ended", onTurnEnded);

  // F10 (#219): after a mid-session reload no event has delivered a paseo api
  // yet, and a turn that STARTED before re-registration can end without
  // turn_ened being delivered to the new handler. turn_started fires one cycle
  // earlier — capture the api there so the next turn_ended is guaranteed to
  // reach the mint path instead of silently bailing on a null api.
  const offTurnStarted = safeOn("agent.turn_started", (_event: unknown, context: { paseo?: unknown }) => {
    if (context?.paseo) capturePaseo(context.paseo as PaseoSendSlice, "turn_started");
  });

  const offHook = registerSubagentReplyHook(server, {
    registry,
    // Port is bound on the next event-loop turn after contribute returns;
    // the daemon cannot deliver a create request to the plugin before then.
    // If it somehow does, the hook throws an honest error below.
    getPort: () => replyServer?.port ?? null,
    allowFull,
    log: (message) => console.log(message),
  });

  // L2 env-door (spec v12 · #157 / plan 7/20): session_open (create/resume/
  // refresh/import) assigns PASEO_SUBAGENTS_DOOR to a main without a door. Reuse
  // the L1 token granted in this process (envDoorUrlFor reads the shared ledger).
  const offEnvDoor = registerEnvDoorHook(server, {
    registry,
    getPort: () => replyServer?.port ?? null,
    allowFull,
    log: (message) => console.log(message),
  }, {
    agentsRoot,
    envDoorUrlFor: (agentId, title) => envDoorUrlForMain(agentsRoot, { registry, getPort: () => replyServer?.port ?? null, allowFull, log: (m) => console.log(m) }, grantLedger, agentId, title, grantStore),
  });

  return () => {
    offHook();
    offEnvDoor();
    offCreated();
    if (idleTimer) clearInterval(idleTimer);
    offTurnEnded();
    offTurnStarted();
    clearInterval(poolTimer);
    replyServer?.close();
  };
}
