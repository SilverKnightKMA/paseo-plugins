import React, { useCallback, useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin";
import { GetSnipStateRpc, SetSnipStateRpc, type SnipState } from "./rpc.js";
import { OmCard, OmHeader, OmSection, OmSessionPicker, omTimeAgo, omViaSuffix } from "./ui.js";

const POLL_MS = 2000;

/**
 * Snip panel: mouse-driven snippet selection. Every toggle applies
 * IMMEDIATELY via set-state (no Apply button — the engine acks within one
 * watch-debounce, ~150ms, and the poll converges on the acked truth).
 */
export function SnipPanel(props: PluginWorkspacePanelProps) {
  const c = props.theme.colors;
  const read = useRpc(GetSnipStateRpc);
  const write = useRpc(SetSnipStateRpc);
  const [data, setData] = useState<SnipState | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // chips override
  const [pending, setPending] = useState(false); // write in flight

  const refresh = useCallback(async () => {
    try {
      setData(await read({ workspaceId: props.workspaceId, sessionId: picked }));
    } catch {
      // RPC hiccup — keep the last snapshot, next poll retries
    }
  }, [props.workspaceId, picked, read]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const apply = useCallback(
    async (active: string[], sticky: boolean) => {
      const sessionId = data?.sessionId;
      if (!sessionId) return;
      setPending(true);
      // optimistic local echo — the poll replaces it with the acked state
      setData((prev) => (prev ? { ...prev, active, sticky } : prev));
      try {
        await write({ workspaceId: props.workspaceId, sessionId, active, sticky });
      } catch {
        // write failed — the poll will restore the engine truth
      }
      await refresh();
      setPending(false);
    },
    [data?.sessionId, props.workspaceId, write, refresh],
  );

  const sessionId = data?.sessionId;
  const resolved = data?.resolved;
  const headerTitle = `Snip${sessionId ? ` · session ${sessionId.slice(0, 8)}${omViaSuffix(resolved?.via)}` : ""}`;
  const acked = data?.engineLive === true;
  const ackPending = Boolean(data?.sentAt && data?.ackAt && data.ackAt < data.sentAt);
  const engineLine = !data
    ? "loading…"
    : !data.present
      ? (data.note ?? "no session")
      : !acked
        ? `engine offline — ${data.note ?? "session has not loaded snip v1.5+"}`
        : ackPending
          ? "engine ack pending…"
          : `engine ok · ack ${omTimeAgo(data.ackAt)}`;

  const active = data?.active ?? [];
  const sticky = data?.sticky ?? false;
  const prepends = (data?.snippets ?? []).filter((s) => s.placement === "prepend");
  const appends = (data?.snippets ?? []).filter((s) => s.placement === "append");

  const toggle = (id: string) => {
    const next = active.includes(id) ? active.filter((x) => x !== id) : [...active, id];
    void apply(next, sticky);
  };

  const row = (s: SnipState["snippets"][number]) => {
    const on = active.includes(s.id);
    return (
      <Pressable key={s.id} onPress={() => toggle(s.id)} style={{ flexDirection: "row", gap: 8, paddingVertical: 5 }}>
        <Text style={{ color: on ? c.accent : c.foregroundMuted, fontFamily: "monospace", fontSize: 12 }}>{on ? "[x]" : "[ ]"}</Text>
        <View style={{ flexShrink: 1 }}>
          <Text style={{ color: c.foreground, fontSize: 12, fontWeight: "500" }}>{s.name}</Text>
          {s.description ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{s.description}</Text> : null}
        </View>
      </Pressable>
    );
  };

  const chipStyle = { backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 };

  return (
    <View style={{ flex: 1, padding: 12, gap: 8, backgroundColor: c.surface0 }}>
      {data == null ? (
        <Text style={{ color: c.foregroundMuted }}>loading…</Text>
      ) : !data.present ? (
        <Text style={{ color: c.foregroundMuted }}>{data.note ?? "no session"}</Text>
      ) : (
        <>
          <OmHeader
            c={c}
            title={headerTitle}
            dim={[
              ...(resolved?.agentTitle ? [`agent: ${resolved.agentTitle}`] : []),
              engineLine + (pending ? " · saving…" : ""),
              active.length === 0 ? "none armed" : `${sticky ? "sticky" : "one-shot"} · ${active.length} armed`,
            ]}
          />
          <OmSessionPicker
            c={c}
            sessions={(data.sessions ?? []).map((s) => ({
              sessionId: s.sessionId,
              label: `${s.active ? "● " : ""}${s.title ? s.title.slice(0, 24) : s.sessionId.slice(0, 8)}${s.engineLive ? "" : " ·off"}`,
              active: s.active,
            }))}
            selectedId={sessionId}
            onPick={(id) => setPicked(id)}
          />

          <OmCard c={c}>
            <OmSection c={c}>PREPEND ↑ — added before your message</OmSection>
            {prepends.length === 0 ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>(none defined)</Text> : prepends.map(row)}
            <OmSection c={c}>APPEND ↓ — added after your message</OmSection>
            {appends.length === 0 ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>(none defined)</Text> : appends.map(row)}
          </OmCard>

          <OmCard c={c}>
            <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <Pressable onPress={() => void apply(active, !sticky)} style={{ ...chipStyle, backgroundColor: sticky ? c.surface2 : c.surface1 }}>
                <Text style={{ color: c.foreground, fontSize: 12 }}>{sticky ? "mode: STICKY" : "mode: ONE-SHOT"}</Text>
              </Pressable>
              <Pressable onPress={() => void apply([], false)} style={{ ...chipStyle, borderColor: c.statusWarning }}>
                <Text style={{ color: c.foreground, fontSize: 12 }}>OFF</Text>
              </Pressable>
            </View>
            <Text style={{ color: c.foregroundMuted, fontSize: 10, marginTop: 6 }}>
              one-shot: applies to the next message then resets · sticky: stays until OFF — same semantics as /snip
            </Text>
          </OmCard>
        </>
      )}
    </View>
  );
}
