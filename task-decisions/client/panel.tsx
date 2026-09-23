import React, { useCallback, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { GetDecisionsRpc, PokeControlRpc, type SessionDecisions } from "../shared/rpc.js";

/**
 * #240 (P1): "Quyết định đang chờ" — one card per undecided decision entry.
 * Buttons WRITE control files through the server RPC (the client never
 * touches disk); the engine applies + stamps decidedAt and the card closes
 * on refetch. The plan-mode button pokes plan-control {action:"on"}.
 */

const POLL_MS = 4000;

function kindLabel(kind: string): string {
  if (kind === "cancel-proposal") return "CANCEL PROPOSAL";
  if (kind === "amend") return "AMEND (judge hold)";
  if (kind === "appeal") return "APPEAL";
  return "NOTE";
}

function Btn({ c, label, onPress, primary }: { c: PluginWorkspacePanelProps["theme"]["colors"]; label: string; onPress: () => void; primary?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingVertical: 4,
        paddingHorizontal: 10,
        borderRadius: 6,
        backgroundColor: primary ? c.accent : c.surface1,
      }}
    >
      <Text style={{ color: primary ? c.surface0 : c.foreground, fontSize: 11, fontWeight: "600" as const }}>{label}</Text>
    </Pressable>
  );
}

function EntryCard({
  c,
  sessionId,
  entry,
  tasks,
  onPoke,
}: {
  c: PluginWorkspacePanelProps["theme"]["colors"];
  sessionId: string;
  entry: SessionDecisions["entries"][number];
  tasks: SessionDecisions["tasks"];
  onPoke: (p: { sessionId: string; action: "proposal-decide" | "cancel"; taskId?: number; dId?: string; decision?: "approved" | "rejected" }) => void;
}) {
  const task = tasks.find((t: { id: number }) => t.id === entry.taskId);
  const ts = entry.createdAt.slice(0, 16).replace("T", " ");
  return (
    <View style={{ borderWidth: 1, borderColor: c.surface2, borderRadius: 8, padding: 10, gap: 6 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 10, fontFamily: "monospace" }}>
        {kindLabel(entry.kind)} · {entry.id} · {ts}
      </Text>
      <Text style={{ color: c.foreground, fontSize: 12 }}>
        #{entry.taskId} {task ? `${task.subject} [${task.status}]` : "(task not on board)"}
      </Text>
      {entry.reason ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{entry.reason}</Text>
      ) : null}
      {entry.kind === "note" ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>display-only — no buttons</Text>
      ) : entry.kind === "cancel-proposal" ? (
        <View style={{ flexDirection: "row" as const, gap: 8 }}>
          <Btn c={c} label="CANCEL TASK" primary onPress={() => onPoke({ sessionId, action: "cancel", taskId: entry.taskId })} />
          <Btn c={c} label="KEEP" onPress={() => onPoke({ sessionId, action: "proposal-decide", taskId: entry.taskId, dId: entry.id, decision: "rejected" })} />
        </View>
      ) : (
        <View style={{ flexDirection: "row" as const, gap: 8 }}>
          <Btn c={c} label="APPROVE" primary onPress={() => onPoke({ sessionId, action: "proposal-decide", taskId: entry.taskId, dId: entry.id, decision: "approved" })} />
          <Btn c={c} label="REJECT" onPress={() => onPoke({ sessionId, action: "proposal-decide", taskId: entry.taskId, dId: entry.id, decision: "rejected" })} />
        </View>
      )}
    </View>
  );
}

export function TaskDecisionsPanel(props: PluginWorkspacePanelProps) {
  const read = useRpc(GetDecisionsRpc);
  const poke = useRpc(PokeControlRpc);
  const [data, setData] = useState<Awaited<ReturnType<typeof read>> | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await read({ workspaceId: props.workspaceId }));
    } catch {
      // keep last; poll retries
    }
  }, [props.workspaceId, read]);

  React.useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const onPoke = useCallback(
    async (p: { sessionId: string; action: "proposal-decide" | "cancel"; taskId?: number; dId?: string; decision?: "approved" | "rejected" }) => {
      try {
        const r = await poke(p);
        setFlash(r.note);
        await refresh();
      } catch (err) {
        setFlash(`poke failed: ${String(err)}`);
      }
    },
    [poke, refresh],
  );

  const c = props.theme.colors;
  const sessions = data?.sessions ?? [];
  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: 12, gap: 10 }}>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "700" as const }}>Quyết định đang chờ</Text>
      {flash ? <Text style={{ color: c.foregroundMuted, fontSize: 10 }}>{flash}</Text> : null}
      {data == null ? (
        <Text style={{ color: c.foregroundMuted }}>loading…</Text>
      ) : sessions.length === 0 ? (
        <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>
          {data.note ?? "no pending decisions"}
        </Text>
      ) : (
        sessions.map((s) => (
          <View key={s.sessionId} style={{ gap: 8 }}>
            <Text style={{ color: c.foregroundMuted, fontSize: 10, fontFamily: "monospace" }}>
              session {s.sessionId.slice(0, 8)}{s.agentTitle ? ` · ${s.agentTitle}` : ""}
            </Text>
            {s.entries.map((e) => (
              <EntryCard key={e.id} c={c} sessionId={s.sessionId} entry={e} tasks={s.tasks} onPoke={(p) => void onPoke(p)} />
            ))}
            <Btn
              c={c}
              label="Bật plan mode"
              onPress={() => {
                void (async () => {
                  try {
                    const r = await poke({ sessionId: s.sessionId, action: "plan-on" });
                    setFlash(r.note);
                  } catch (err) {
                    setFlash(`plan poke failed: ${String(err)}`);
                  }
                })();
              }}
            />
          </View>
        ))
      )}
    </ScrollView>
  );
}
