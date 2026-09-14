import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { HealthPanel } from "./client/panel.js";
import { SubagentNoticeCard, type SubagentNoticeData } from "./client/subagent-notice.js";
import { MachineNoticeCard } from "./client/machine-notice.js";
import { MutedAbortCard } from "./client/muted-abort.js";
import { SystemChip } from "./client/system-chip.js";
import { OmLogCard } from "./client/om-log.js";
import { startZwLive } from "./client/zw-pill.js";

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "agent-health",
    title: "Agent Health",
    icon: "Activity",
    context: "workspace",
    Component: HealthPanel,
  });

  client.addCommandCenterItem({
    id: "agent-health-open",
    title: "Agent Health: agents & zombie-watchdog",
    icon: "Activity",
    keywords: ["zombie", "watchdog", "health", "agents"],
    context: "workspace",
    onSelect(context_) {
      context_.openPanel("agent-health");
    },
  });

  // ZW alert pill: hidden unless a fresh zombie detection fires (see client/zw-pill.ts)
  const stopPill = startZwLive(client);

  // ── subagent notice cards ─────────────────────────────────────────────
  // The subagent channel delivers <subagent-message …> blocks as plain
  // user-message text; the app prints the raw tags + duplicated UUIDs.
  // Transform (render-layer only) replaces them with a clean plugin card.
  client.addTimelineTransformer({
    id: "subagent-report-transformer",
    query: { itemType: "user_message" },
    transform: ({ item }) => {
      if (item.type !== "user_message") return undefined;
      // one user message may contain multiple envelopes (drain joins with "\n\n")
      const parsedAll = parseAllSubagentNotices(item.text);
      if (parsedAll.length > 0) {
        return {
          items: parsedAll.map((parsed) => ({
            type: "plugin" as const,
            kind: "subagent-report",
            version: 1,
            data: parsed,
          })),
        };
      }
      // #52: pool notices ride the same user-message path under the
      // <machine-notice> envelope — restyle as a card, model payload intact.
      const machines = parseAllMachineNotices(item.text);
      if (machines.length > 0) {
        return {
          items: machines.map((m) => ({
            type: "plugin" as const,
            kind: "machine-notice",
            version: 1,
            data: m,
          })),
        };
      }
      return undefined;
    },
  });

  client.addTimelineRenderer({
    kind: "subagent-report",
    version: 1,
    schema: z.object({
      role: z.string(),
      kind: z.string(),
      agentId: z.string(),
      name: z.string().nullable(),
      body: z.string(),
      tone: z.enum(["ok", "info", "warn"]),
    }),
    Component: SubagentNoticeCard,
  });

  client.addTimelineRenderer({
    kind: "machine-notice",
    version: 1,
    schema: z.object({ kind: z.string(), body: z.string() }),
    Component: MachineNoticeCard,
  });

  // ── abort cards (v2, 2026-09-05) ─────────────────────────────────────
  // Today's RCA: stopReason=error + "operation was aborted" = an undici
  // AbortError from the zaicp relay dropping the stream MID-FLIGHT (daemon
  // log turn_failed; happened ~1/hour for 2 days) — the turn really died,
  // show a warning to tell "dead" apart from "hung". "Request aborted"/
  // stopReason=aborted = a deliberate cancel (user STOP or daemon
  // interrupt-and-replace on child notify) — one muted line is enough.
  // Render-layer only; the transcript stays untouched.
  client.addTimelineTransformer({
    id: "muted-abort-transformer",
    query: { itemType: "error" },
    transform: ({ item }) => {
      if (item.type !== "error") return undefined;
      const msg: string = item.message ?? "";
      if (!/operation was aborted/i.test(msg) && !/request aborted/i.test(msg)) return undefined;
      const cls = /operation was aborted/i.test(msg) && /stopReason\s*=\s*error/i.test(msg)
        ? ("relay-drop" as const)
        : ("superseded" as const);
      return { items: [{ type: "plugin" as const, kind: "muted-abort", version: 2, data: { message: msg, cls } }] };
    },
  });

  client.addTimelineRenderer({
    kind: "muted-abort",
    version: 2,
    schema: z.object({ message: z.string(), cls: z.enum(["relay-drop", "superseded"]) }),
    Component: MutedAbortCard,
  });

  // ── chat-polish (2026-09-14) ───────────────────────────────────────────
  // Why: the daemon pi provider maps EVERY custom message (om-timeline,
  // om.resume) to a plain assistant_message item (providers/pi/agent.js
  // handleMessageEnd: role "custom" → text), and agent-manager injects
  // "[System Error] …" as a fake assistant_message too. All three noise
  // types therefore render exactly like agent prose. Restyle by prefix:
  //   • "[System Error] …aborted…" → warning card (reuse muted-abort v2;
  //     the old error-item transformer never sees these — wrong itemType)
  //   • "[automatic] Your context was just compacted…" → one dim chip
  //   • "om: …" multi-line status log → compact om card
  // Render-layer only; transcripts and model context stay untouched.
  client.addTimelineTransformer({
    id: "chat-polish-transformer",
    query: { itemType: "assistant_message" },
    transform: ({ item }) => {
      if (item.type !== "assistant_message") return undefined;
      const trimmed = (item.text ?? "").trim();
      if (trimmed.startsWith("[System Error]")) {
        const message = trimmed.slice("[System Error]".length).trim();
        const cls = /stopReason\s*=\s*error/i.test(message) ? ("relay-drop" as const) : ("superseded" as const);
        return {
          items: [{ type: "plugin" as const, kind: "muted-abort", version: 2, data: { message, cls } }],
        };
      }
      if (trimmed.startsWith("[automatic] Your context was just compacted")) {
        return {
          items: [{ type: "plugin" as const, kind: "system-chip", version: 1, data: { notice: "context-compacted" } }],
        };
      }
      if (trimmed.startsWith("om: ")) {
        return { items: [{ type: "plugin" as const, kind: "om-log", version: 1, data: { text: trimmed } }] };
      }
      return undefined;
    },
  });

  client.addTimelineRenderer({
    kind: "system-chip",
    version: 1,
    schema: z.object({ notice: z.string() }),
    Component: SystemChip,
  });

  client.addTimelineRenderer({
    kind: "om-log",
    version: 1,
    schema: z.object({ text: z.string() }),
    Component: OmLogCard,
  });

  return () => {
    stopPill();
  };
}

const SUBAGENT_RE =
  /^<subagent-message from="([0-9a-f-]{36})" role="([\w-]+)" kind="([\w-]+)">\n?([\s\S]*?)\n?<\/subagent-message>$/;

const SUBAGENT_BLOCK_RE =
  /<subagent-message from="[0-9a-f-]{36}" role="[\w-]+" kind="[\w-]+">[\s\S]*?<\/subagent-message>/g;
const MACHINE_NOTICE_BLOCK_RE = /<machine-notice kind="[\w-]+">\n?[\s\S]*?\n?<\/machine-notice>/g;

export type MachineNoticeParsed = { kind: string; body: string };

/** Split a user message into <machine-notice> envelopes; [] = not ours.
 *  Same all-or-nothing rule as subagent notices: a partial match (e.g. the
 *  pending-followUp tray gluing extra user text after the envelope) stays
 *  pass-through rather than half-rendering. MARKERS.md marker 5. */
function parseAllMachineNotices(text: string): MachineNoticeParsed[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<machine-notice")) return [];
  const blocks = trimmed.match(MACHINE_NOTICE_BLOCK_RE) ?? [];
  if (blocks.length === 0) return [];
  const parsed: MachineNoticeParsed[] = [];
  for (const b of blocks) {
    const m = /^<machine-notice kind="([\w-]+)">\n?([\s\S]*?)\n?<\/machine-notice>$/.exec(b.trim());
    if (!m) return []; // any malformed block -> not ours, show raw
    parsed.push({ kind: m[1], body: m[2].trim() });
  }
  return parsed;
}



/** Split a user message into envelopes, parse each; [] = not ours. */
function parseAllSubagentNotices(text: string): SubagentNoticeData[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith("<subagent-message")) return [];
  const blocks = trimmed.match(SUBAGENT_BLOCK_RE) ?? [];
  if (blocks.length === 0) return [];
  // every block must match the format; a partial match stays pass-through
  const parsed = blocks.map((b) => parseSubagentNotice(b));
  return parsed.every((p) => p !== null) ? (parsed as SubagentNoticeData[]) : [];
}

/** Parse + clean a <subagent-message> block into card data; null = not ours. */
function parseSubagentNotice(text: string): SubagentNoticeData | null {
  const m = SUBAGENT_RE.exec(text.trim());
  if (!m) return null;
  const [, agentId, role, kindTag, rawBody] = m;
  let body = rawBody.trim();
  let tone: SubagentNoticeData["tone"] = "info";
  let label = kindTag;
  const tag = /^\[([a-z][a-z-]*)\]\s*/i.exec(body);
  if (tag) {
    label = tag[1].toLowerCase();
    body = body.slice(tag[0].length);
    if (label === "auto-report") tone = "ok";
    else if (label === "channel-nack") tone = "warn";
  }
  let name: string | null = null;
  const nm = /Subagent [\w-]+ "([^"]+)" \(([0-9a-f-]{36})\)/.exec(body);
  if (nm) {
    name = nm[1];
    body = body.replace(` "${nm[1]}" (${nm[2]})`, ` "${nm[1]}"`); // drop the duplicated UUID in the body
  }
  return { role, kind: label, agentId, name, body, tone };
}
