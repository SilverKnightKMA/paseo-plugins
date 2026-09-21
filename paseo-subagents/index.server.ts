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
import { registerSubagentReplyHook, PARENT_ENV, MAIN_MCP_KEY } from "./server/hooks.js";
import { canAnswer, makeQuestionId, type PendingQuestion } from "./server/ask.js";
import { composeInitialPrompt, resolveRole, type PluginSettings } from "./server/roles.js";
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
import { doorGrantMessage, GrantLedger, mintDoorForMain, readMainDoorState, shouldGrant } from "./server/grant.js";

/** Max depth tuyệt đối (spec mục 6): main=0 → con=1 → cháu=2. */
const MAX_DEPTH = 2;

/** Structural slice of the SDK API the door needs (avoids importing
 *  @getpaseo/client, which is not a plugin-SDK specifier). */
interface PaseoSendSlice {
  agents: {
    ref(id: string): { send(text: string): Promise<void> };
    create(options: {
      config: { provider: string; title?: string; mcpServers?: Record<string, unknown>; modeId?: string };
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

  // Repo wins (spec v6): settings.json trong repo plugin là source of truth,
  // nạp 1 lần lúc load. Env PASEO_SUBAGENTS_SETTINGS chỉ đường khác nếu cần.
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
      console.log(`[paseo-subagents] settings load failed (${err instanceof Error ? err.message : String(err)}) — dùng default`);
      return {};
    }
  })();

  // ── Idle-archive reminder (#141 / plan step 7) ─────────────────────────
  // Daemon-side port của #129: quét record đĩa mỗi 60s, nhắc parent qua
  // đúng kênh deliver khi mọi con (label subagent.parent) idle ≥ N phút.
  // REMIND, không auto-archive. 0 = tắt. Chỉ track con của plugin để không
  // đôi lời với pi ext (nó tự nhắc con của nó trong process pi).
  const remindMinutes = (() => {
    const raw = Number(process.env.PASEO_SUBAGENTS_ARCHIVE_REMIND_MINUTES);
    return Number.isFinite(raw) && raw >= 0 ? Math.min(Math.round(raw), 1440) : DEFAULT_REMIND_MINUTES;
  })();
  const lastRemindByParent = new Map<string, number>();
  const agentsRoot = join(homedir(), ".paseo", "agents");

  const scanIdleArchive = async (): Promise<void> => {
    const api = paseoApi;
    if (!api) return; // chưa có lifecycle context — chờ lượt quét sau
    try {
      const records = readAgentRecords(agentsRoot);
      const byId = new Map(records.map((r) => [r.id, r]));
      const parents = new Set<string>();
      for (const r of records) {
        if (r.labels?.["subagent.spawner"] !== "paseo-subagents") continue;
        const p = r.labels?.["subagent.parent"];
        // không nhắc parent đã archive (send sẽ auto-unarchive — tránh đánh thức)
        if (p && p !== "(main)" && !byId.get(p)?.archivedAt) parents.add(p);
      }
      for (const parent of parents) {
        const children = toIdleChildren(records, parent);
        const r = shouldRemindIdleArchive(children, Date.now(), remindMinutes);
        if (!r) continue;
        if (!reminderArmed(lastRemindByParent.get(parent), Date.now())) continue;
        lastRemindByParent.set(parent, Date.now());
        console.log(
          `[paseo-subagents] idle-archive reminder: ${children.length} con của ${parent} idle ≥${remindMinutes}m`,
        );
        await api.agents.ref(parent).send(
          `[housekeeping] ${children.length} subagents đã idle ≥${remindMinutes} phút, không con nào đang chạy/parked. Archive để giữ danh sách gọn (soft-delete — gửi tin cho con sẽ tự unarchive):\n${r.command}`,
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
    `[paseo-subagents] idle-archive scanner ${remindMinutes > 0 ? `armed (${remindMinutes}m, quét 60s/lần)` : "disabled (0)"}`,
  );

  const spawnChild = async (
    caller: CallerCaps,
    args: SpawnArgs,
    extraLabels?: Record<string, string>,
  ): Promise<{ agentId: string } | { error: string }> => {
    const api = paseoApi;
    if (!api) return { error: "paseo API not captured yet — daemon lifecycle context missing" };
    if (caller.depth >= MAX_DEPTH) {
      return { error: `depth cap: caller depth=${caller.depth}, max=${MAX_DEPTH} (spec mục 6 — kìm đệ quy)` };
    }
    const resolved = resolveRole(args.role, settings);
    if (!resolved.ok) return { error: resolved.error };
    const { role } = resolved;
    const title = args.name ?? `${args.role}: ${args.task.slice(0, 40)}`;
    const initialPrompt = composeInitialPrompt(role, args.task);

    // SpawnFn tự mint door scoped cho child (spec 4.1): không dựa env carrier —
    // env qua SDK agents.create không tới được hook before(agent.create) (E2E 2026-09-20: child nhận nhầm main door).
    const parentId = caller.boundAgentId;
    if (!parentId) {
      return { error: "main door token chưa bind agentId (agent.created chưa về) — thử lại sau giây lát" };
    }
    const port = replyServer?.port ?? null;
    if (port === null) return { error: "reply door chưa listen — thử lại sau giây lát" };
    const token = registry.mint(parentId, title, { depth: caller.depth + 1, canSpawn: false, role: args.role });
    const childDoorUrl = `http://127.0.0.1:${port}/mcp?caller=${token}`;

    const labels: Record<string, string> = {
      // idle-archive: plugin chỉ nhắc con CHÍNH NÓ spawn — pi ext children
      // cũng mang subagent.parent nên thiếu label này sẽ đôi lời (E2E 18:03:
      // parent cf76ad71 nhận reminder từ cả 2 engine).
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
          mcpServers: {
            paseo: { type: "http" as const, url: childDoorUrl, alwaysLoad: true },
          },
        },
        cwd: process.cwd(), // TODO(E2E): lấy cwd của caller agent khi slice mở rộng
        prompt: initialPrompt,
        labels,
        parent: parentId,
      });
      console.log(`[paseo-subagents] spawn_subagent: role=${args.role} -> agent ${child.id} (parent ${parentId}, depth ${caller.depth + 1}, door scoped 1 tool)`);
      return { agentId: child.id };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };

  const spawnFn: SpawnFn = (caller, args) => spawnChild(caller, args);

  // ── spawn_pool (#145 / plan step 10): fan-out 2-12 children, ≤4 song song,
  // một envelope [pool-report] aggregate khi mọi con terminal. State pool nằm
  // trong RAM plugin process (đủ cho v1 — restart daemon mất pool đang chạy,
  // con vẫn tự báo [child-report] riêng nên không mất dữ liệu).
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
    if (childIds.length === 0) return { error: "spawn_pool: mọi item spawn thất bại (xem log plugin)" };
    pools.set(poolId, { parentId: caller.boundAgentId ?? "", createdAt: Date.now(), childIds, titles });
    console.log(`[paseo-subagents] spawn_pool ${poolId}: ${childIds.length}/${args.items.length} con (parent ${caller.boundAgentId}, concurrency ${args.concurrency ?? 4})`);
    return { poolId, spawned: childIds.length };
  };

  // Watcher pool: quét record đĩa 30s/lần; mọi con terminal (idle/error/archived)
  // → gửi MỘT [pool-report] aggregate rồi quên pool. Pool >2h → flush partial.
  const scanPools = async (): Promise<void> => {
    const api = paseoApi;
    if (!api || pools.size === 0) return;
    let records: ReturnType<typeof readAgentRecords>;
    try {
      records = readAgentRecords(agentsRoot);
    } catch {
      return; // đĩa lỗi tạm — quét lượt sau
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
        pools.delete(poolId); // record biến mất (đã delete) — không đợi nữa
        continue;
      }
      const text = aggregatePoolReport(poolId, children, (c) => ({
        label: pool.titles.get(c.id) ?? c.id,
        state: c.archivedAt ? "archived" : (c.lastStatus ?? "unknown"),
      })) + (aged && !allTerminal(children) ? "\n(pool vượt 2h — flush partial, các con chưa terminal sẽ tự báo [child-report] riêng)" : "");
      pools.delete(poolId);
      try {
        console.log(`[paseo-subagents] pool-report ${poolId} -> parent ${pool.parentId}`);
        await api.agents.ref(pool.parentId).send(text);
      } catch (err) {
        console.log(`[paseo-subagents] pool-report deliver failed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  };
  const poolTimer = setInterval(() => {
    void scanPools();
  }, 30_000);
  poolTimer.unref?.();

  // ── ask_parent / answer_child (#146 / plan step 11) — pending RAM,
  // restart mất câu hỏi treo (con có thể hỏi lại — fail-honest).
  const pendingQuestions = new Map<string, PendingQuestion>();
  const askFn: AskFn = async (caller, parentId, question) => {
    const api = paseoApi;
    if (!api) return { error: "paseo API not captured yet — thử lại sau" };
    const childId = caller.boundAgentId;
    if (!childId) return { error: "door token chưa bind agentId — thử lại sau giây lát" };
    const questionId = makeQuestionId();
    try {
      await api.agents
        .ref(parentId)
        .send(`[child-question] con (${childId.slice(0, 8)}) hỏi: ${question}\nTrả lời bằng tool answer_child với questionId=${questionId}`);
      pendingQuestions.set(questionId, { questionId, childId, parentId, createdAt: Date.now() });
      console.log(`[paseo-subagents] ask_parent ${questionId}: con ${childId.slice(0, 8)} -> parent ${parentId.slice(0, 8)}`);
      return { questionId };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  const answerFn: AnswerFn = async (caller, questionId, answer) => {
    const api = paseoApi;
    if (!api) return { error: "paseo API not captured yet" };
    const pending = pendingQuestions.get(questionId);
    if (!pending) return { error: `questionId '${questionId}' không tồn tại (đã trả lời hoặc plugin restart) — con sẽ hỏi lại nếu còn cần` };
    if (!canAnswer(pending, caller.boundAgentId)) return { error: "chỉ parent của câu hỏi mới được trả lời" };
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
    deliver: (parentId, title, prompt) => {
      const api = paseoApi;
      if (!api) return Promise.reject(new Error("paseo API not captured yet — daemon lifecycle context missing"));
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
    // Event chỉ mang metadata (PluginHookAgent không có config) — đọc record file để lấy door URL đã inject,
    // rồi bind token → agentId (main mint token TRƯỚC khi có id — spec 4.2).
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
        console.log(`[paseo-subagents] agent.created '${event.agent.title ?? id}': no door URL in record — bỏ bind (agent không do plugin door hóa)`);
      }
    } catch (err) {
      console.log(`[paseo-subagents] bind main door failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  // Scanner cần paseoApi nhưng capture lười qua agent.created là mong manh:
  // sau restart, nếu không có agent MỚI nào được tạo thì scanner chết ngắt
  // (E2E 17:51: reminder không nổ dù grace đã hết). Bắt thêm từ các event
  // hay gặp nhất — mọi turn kết thúc của BẤT KỲ agent nào cũng đủ.
  // Event lạ (runtime từ chối tên) KHÔNG được giết plugin — bắt từng cái.
  const safeOn = (name: string, fn: unknown): (() => void) => {
    try {
      const off = (server.on as unknown as (n: string, f: unknown) => () => void)(name, fn);
      return typeof off === "function" ? off : () => {};
    } catch (err) {
      console.log(`[paseo-subagents] event '${name}' không đăng ký được: ${err instanceof Error ? err.message : String(err)} — bỏ qua`);
      return () => {};
    }
  };
  // ── L1 door-grant (spec v12 mục 11 · #156 / plan 6/20) ────────────────
  // Main sinh TRƯỚC plugin không có door trong record; khi main đó kết thúc
  // turn, plugin mint token mới + gửi '[door-grant] <url>' vào chat. Guard:
  // đúng 1 lần/process/agent (GrantLedger), chỉ main không-door chưa archived.
  // Tự lành sau restart (ledger RAM rỗng → turn kế grant lại). KHÔNG ghi record.
  const grantLedger = new GrantLedger();
  const onTurnEnded = (event: unknown, context: { paseo?: unknown }): void => {
    if (context?.paseo) capturePaseo(context.paseo as PaseoSendSlice, "turn_ended");
    try {
      const agent = (event as { agent?: { id?: string; title?: string } } | null)?.agent;
      const id = agent?.id;
      if (!id || !grantLedger.allow(id)) return;
      const state = readMainDoorState(agentsRoot, id);
      if (!shouldGrant(state)) return; // đã có door / child / archived / không record
      const api = paseoApi;
      if (!api) return; // chưa có lifecycle context — turn sau thử lại
      const url = mintDoorForMain({ registry, getPort: () => replyServer?.port ?? null, allowFull, log: (m) => console.log(m) }, id, agent.title ?? "main");
      if (!url) return; // door chưa listen — turn sau thử lại
      grantLedger.mark(id);
      void api.agents
        .ref(id)
        .send(doorGrantMessage(url))
        .then(() => console.log(`[paseo-subagents] door-grant đã gửi -> agent ${id} (main không-door, L1)`))
        .catch((err: unknown) => console.log(`[paseo-subagents] door-grant send failed (${id}): ${err instanceof Error ? err.message : String(err)}`));
    } catch (err) {
      console.log(`[paseo-subagents] door-grant check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const offTurnEnded = safeOn("agent.turn_ended", onTurnEnded);

  const offHook = registerSubagentReplyHook(server, {
    registry,
    // Port is bound on the next event-loop turn after contribute returns;
    // the daemon cannot deliver a create request to the plugin before then.
    // If it somehow does, the hook throws an honest error below.
    getPort: () => replyServer?.port ?? null,
    allowFull,
    log: (message) => console.log(message),
  });

  return () => {
    offHook();
    offCreated();
    if (idleTimer) clearInterval(idleTimer);
    offTurnEnded();
    clearInterval(poolTimer);
    replyServer?.close();
  };
}
