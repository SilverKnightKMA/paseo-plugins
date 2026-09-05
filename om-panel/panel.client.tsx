import React, { useCallback, useEffect, useState } from "react";
import { Text, View, ScrollView } from "react-native";
import { useRpc } from "@getpaseo/plugin";
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin";
import { GetOmStateRpc, type OmPanelState } from "./rpc.js";
import { OmCard, OmHeader, OmSection, OmSessionPicker, omChipLabel, omTimeAgo, omViaSuffix } from "./ui.js";

const POLL_MS = 30_000;

/**
 * v2: session-first. Header giữ mốc "session đang tracked" (active marker +
 * cách resolve), chip-switcher để nhảy sang session cũ, thân panel là danh
 * sách topic files của session đang chọn. UI kit dùng chung với om-status
 * (ui.tsx) — 2 panel nhìn và cảm giác như một.
 */
export function OmPanel({ theme, workspaceId }: PluginWorkspacePanelProps) {
  const getState = useRpc(GetOmStateRpc);
  const [data, setData] = useState<OmPanelState | null>(null);
  const [picked, setPicked] = useState<string | null>(null); // override từ switcher
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getState({ workspaceId, sessionId: picked, indexLines: 10 }));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [getState, workspaceId, picked]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const c = theme.colors;
  const sel = data?.session;
  const resolved = data?.resolved;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: c.surface0, padding: 12 }}>
      <OmHeader
        c={c}
        title={`${data?.workspace ?? workspaceId} · session ${(resolved?.sessionId ?? "?").slice(0, 8)}${omViaSuffix(resolved?.via)}`}
        dim={[
          ...(resolved?.agentTitle ? [`agent: ${resolved.agentTitle}`] : []),
          ...(sel
            ? [`${sel.topicFiles} topics · ${sel.totalKb} KB · cập nhật ${omTimeAgo(sel.lastModified)}`]
            : [data?.note ?? "…"]),
          ...(data ? [`live · poll ${POLL_MS / 1000}s`] : []),
        ]}
      />

      <OmSessionPicker
        c={c}
        sessions={data?.sessions.map((s) => ({
          sessionId: s.sessionId,
          label: omChipLabel(s.active, s.title, s.sessionId, s.topicFiles),
          active: s.active,
        })) ?? []}
        selectedId={resolved?.sessionId}
        onPick={(id) => setPicked(id)}
      />

      {error ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>rpc error: {error}</Text> : null}

      {sel ? (
        <OmCard c={c} noRail>
          <OmSection c={c}>Topic files (mới nhất trước)</OmSection>
          {sel.topics.map((t) => (
            <View key={t.file} style={{ flexDirection: "row", marginBottom: 3, gap: 8 }}>
              <Text style={{ color: c.foreground, fontSize: 12, flexShrink: 1 }} numberOfLines={1}>
                {t.file}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 11, marginLeft: "auto" }}>
                {t.kb} KB · {omTimeAgo(t.modified)}
              </Text>
            </View>
          ))}
          {sel.topics.length === 0 ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>chưa có topic nào</Text> : null}

          {sel.indexHead.length > 0 ? (
            <>
              <OmSection c={c}>INDEX.md</OmSection>
              {sel.indexHead.map((line, i) => (
                <Text key={i} style={{ color: c.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
                  {line}
                </Text>
              ))}
            </>
          ) : null}
        </OmCard>
      ) : null}

    </ScrollView>
  );
}
