import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginContext } from "@getpaseo/plugin";
import { z } from "zod";
import { SnipPanel } from "./panel.client";
import { startSnipLive } from "./pill.client";
import { GetSnipStateRpc, SetSnipStateRpc, SnippetBriefSchema, type SnipState } from "./rpc.js";
import { mergeLiveTitles, titleFor } from "./titles.js";

const EMPTY: SnipState = {
  present: false,
  note: null,
  sessionId: null,
  active: [],
  sticky: false,
  sentAt: null,
  ackAt: null,
  ackAgeSec: null,
  engineLive: false,
  snippets: [],
  sessions: [],
};

const ControlFileSchema = z.object({
  v: z.literal(1),
  active: z.array(z.string()),
  sticky: z.boolean(),
  sentAt: z.string().nullish(),
  ackAt: z.string().nullish(),
});

type SnippetBrief = z.infer<typeof SnippetBriefSchema>;

type AgentLike = {
  id?: string;
  workspaceId?: string | null;
  status?: string | null;
  updatedAt?: string | null;
  lastUserMessageAt?: string | null;
  title?: string | null;
  runtimeInfo?: { sessionId?: string | null } | null;
};

/** Wire entries are wrappers: { agent: <snapshot> }. Unwrap defensively. */
function unwrapAgents(entries: unknown[]): AgentLike[] {
  const out: AgentLike[] = [];
  for (const e of entries) {
    const inner = (e as { agent?: unknown }).agent;
    if (inner && typeof inner === "object") out.push(inner as AgentLike);
  }
  return out;
}

function controlDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "snip-control");
}

function snippetsDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "extensions", "snip", "snippets");
}

function controlFile(sessionId: string): string {
  return path.join(controlDir(), `${sessionId}.json`);
}

/** Parse a snippet markdown file (frontmatter + body) — port of the extension's parser. */
function parseSnippet(filename: string, raw: string): SnippetBrief | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  if (!match[2].trim()) return null;
  const parsedOrder = Number.parseInt(meta.order ?? "", 10);
  return {
    id: filename,
    name: meta.name || filename.replace(/\.md$/i, ""),
    description: meta.description ?? "",
    placement: meta.placement === "prepend" ? "prepend" : "append",
    order: Number.isFinite(parsedOrder) ? parsedOrder : 9999,
  };
}

async function readSnippets(): Promise<SnippetBrief[]> {
  try {
    const files = await readdir(snippetsDir());
    const out: SnippetBrief[] = [];
    for (const file of files) {
      if (!file.toLowerCase().endsWith(".md")) continue;
      try {
        const parsed = parseSnippet(file, await readFile(path.join(snippetsDir(), file), "utf8"));
        if (parsed) out.push(parsed);
      } catch {
        // unreadable file — skip
      }
    }
    const byOrder = (a: SnippetBrief, b: SnippetBrief) => a.order - b.order || a.name.localeCompare(b.name);
    return [...out.filter((s) => s.placement === "prepend").sort(byOrder), ...out.filter((s) => s.placement === "append").sort(byOrder)];
  } catch {
    return [];
  }
}

async function readControlFile(sessionId: string) {
  try {
    return ControlFileSchema.parse(JSON.parse(await readFile(controlFile(sessionId), "utf8")));
  } catch {
    return null;
  }
}

async function readSnipState(
  input: { workspaceId: string; agentId?: string | null; sessionId?: string | null },
  context: Parameters<Parameters<PluginContext["handle"]>[1]>[1],
): Promise<SnipState> {
  try {
    let agents: AgentLike[] = [];
    try {
      agents = unwrapAgents((await context.paseo.agents.list()).entries);
    } catch {
      agents = [];
    }
    const titleBySession = new Map<string, string>();
    for (const a of agents) {
      const sid = a.runtimeInfo?.sessionId;
      if (sid && a.title) titleBySession.set(sid, a.title);
    }

    // 1) resolution: explicit (chips picker) > agentId (pill) > workspace-active
    let resolved: SnipState["resolved"] = undefined;
    if (input.sessionId) {
      const agent = agents.find((a) => a.runtimeInfo?.sessionId === input.sessionId);
      resolved = { agentId: agent?.id ?? null, agentTitle: agent?.title ?? null, sessionId: input.sessionId, via: "explicit" };
    } else if (input.agentId) {
      const agent = agents.find((a) => a.id === input.agentId);
      const sessionId = agent?.runtimeInfo?.sessionId ?? null;
      if (sessionId) resolved = { agentId: input.agentId, agentTitle: agent?.title ?? null, sessionId, via: "agent" };
    } else {
      const inWs = agents.filter((a) => a.workspaceId === input.workspaceId);
      const running = inWs.filter((a) => a.status === "running");
      const pool = running.length > 0 ? running : inWs;
      const ts = (a: AgentLike) => Math.max(Date.parse(a.lastUserMessageAt ?? "") || 0, Date.parse(a.updatedAt ?? "") || 0);
      const agent = pool.sort((a, b) => ts(b) - ts(a))[0];
      const sessionId = agent?.runtimeInfo?.sessionId ?? null;
      if (sessionId && agent?.id) resolved = { agentId: agent.id, agentTitle: agent?.title ?? null, sessionId, via: "workspace-active" };
    }

    // 2) side list: sessions the ENGINE touched (control files) — main chats
    // only: the engine skips subagent sessions (parentSession set), so this
    // never floods with spawned scouts/workers. Live agents still feed the
    // title map; they just don't add picker entries.
    const titleCache = mergeLiveTitles(titleBySession);
    const engineSessions = new Set<string>();
    try {
      for (const f of await readdir(controlDir())) if (f.endsWith(".json")) engineSessions.add(f.replace(/\.json$/, ""));
    } catch {
      // no control dir yet — engine v1.5 never ran
    }
    const sessions = [] as SnipState["sessions"];
    for (const sessionId of engineSessions) {
      sessions.push({
        sessionId,
        title: titleFor(titleCache, sessionId, titleBySession),
        active: sessionId === resolved?.sessionId,
        engineLive: (await readControlFile(sessionId)) != null,
      });
    }

    if (!resolved) {
      return { ...EMPTY, sessions, note: "no active agent with a session — pick a chip once the engine has run" };
    }

    const file = await readControlFile(resolved.sessionId);
    const snippets = await readSnippets();
    if (!file) {
      return {
        ...EMPTY,
        present: true,
        sessionId: resolved.sessionId,
        resolved,
        snippets,
        sessions,
        note: "engine offline for this session — snip v1.5+ loads at session start (respawn old sessions to pick it up)",
      };
    }
    return {
      present: true,
      note: null,
      sessionId: resolved.sessionId,
      active: file.active,
      sticky: file.sticky,
      sentAt: file.sentAt ?? null,
      ackAt: file.ackAt ?? null,
      ackAgeSec: file.ackAt ? Math.round((Date.now() - Date.parse(file.ackAt)) / 1000) : null,
      engineLive: file.ackAt != null,
      snippets,
      sessions,
      resolved,
    };
  } catch {
    return EMPTY;
  }
}

async function writeSnipState(input: { sessionId: string; active: string[]; sticky: boolean }) {
  const file = controlFile(input.sessionId);
  const sentAt = new Date().toISOString();
  await mkdir(path.dirname(file), { recursive: true });
  const payload = { v: 1, active: input.active, sticky: input.sticky, sentAt };
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(payload), "utf8");
  await rename(tmp, file);
  return { ok: true, sentAt, note: null };
}

export default function contribute(plugin: PluginContext) {
  plugin.handle(GetSnipStateRpc, async (input, context) => readSnipState(input, context));

  plugin.handle(SetSnipStateRpc, async (input) => {
    try {
      return await writeSnipState(input);
    } catch {
      return { ok: false, sentAt: "", note: "write failed — is ~/.pi/agent/snip-control writable?" };
    }
  });

  plugin.addWorkspacePanel({
    id: "snip",
    title: "Snip",
    icon: "MessageSquare",
    context: "workspace",
    Component: SnipPanel,
  });

  plugin.addCommandCenterItem({
    id: "snip-open",
    title: "Snip: prompt snippets on/off",
    icon: "MessageSquare",
    keywords: ["snip", "snippet", "prompt", "rules"],
    context: "workspace",
    onSelect(context_: { openPanel: (id: string) => void }) {
      context_.openPanel("snip");
    },
  });

  // Composer pill: live active-count gauge per agent, model-invisible by
  // construction (client render layer only, never in pi's state.messages).
  plugin.addClientSide((client) => startSnipLive(client));

  return () => {};
}
