// ui.tsx — SHARED UI kit cho om-status + om-panel (v1.0.2).
// A byte-identical copy lives in BOTH plugin dirs because the daemon checks
// each plugin out separately (git source:plugin/path) — no cross-import at
// runtime. Repo-level check-shared-ui.py + a CI step enforce the two copies
// stay identical: edit here, copy to the other in the SAME commit or CI red.
import React, { useState } from "react";
import { Text, View, Pressable, TextInput } from "react-native";
import type { ReactNode } from "react";

/** Theme colors this kit needs — structural type, no SDK types pulled in. */
export type OmColors = {
  surface0: string;
  surface1: string;
  surface2: string;
  border: string;
  accent: string;
  statusWarning: string;
  foreground: string;
  foregroundMuted: string;
};

export const OM_RADIUS_CARD = 8;
export const OM_RADIUS_INPUT = 6;

/** "42s ago / 5m ago / 3h ago / 2d ago" — shared footer format. */
export function omTimeAgo(iso: string | null): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.floor(s / 60)}m ago`;
  if (s < 129600) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** How the displayed session was resolved — labels shared by both panels. */
export const OM_VIA_LABEL: Record<string, string> = {
  explicit: "selected",
  agent: "pill agent",
  "workspace-active": "agent active",
  newest: "newest",
};

export function omViaSuffix(via: string | null | undefined): string {
  if (!via) return "";
  return ` (${OM_VIA_LABEL[via] ?? via})`;
}

/** Card: surface1 background + 3px left rail (accent default, override via prop). */
export function OmCard(props: {
  c: OmColors;
  rail?: string;
  noRail?: boolean;
  children: ReactNode;
  style?: object;
}) {
  const { c, rail, noRail, children, style } = props;
  return (
    <View
      style={{
        backgroundColor: c.surface1,
        borderRadius: OM_RADIUS_CARD,
        padding: 10,
        ...(noRail ? {} : { borderLeftWidth: 3, borderLeftColor: rail ?? c.accent }),
        ...style,
      }}
    >
      {children}
    </View>
  );
}

/** Standard header card: title 13/600 + dim lines 11. */
export function OmHeader(props: { c: OmColors; title: string; dim?: string[]; rail?: string }) {
  const { c, title, dim, rail } = props;
  return (
    <OmCard c={c} rail={rail} style={{ borderWidth: 1, borderColor: c.border, marginBottom: 10 }}>
      <Text style={{ color: c.foreground, fontSize: 13, fontWeight: "600" as const, marginBottom: dim?.length ? 6 : 0 }}>
        {title}
      </Text>
      {dim?.map((line, i) => (
        <Text key={i} style={{ color: c.foregroundMuted, fontSize: 11, marginBottom: 2 }}>
          {line}
        </Text>
      ))}
    </OmCard>
  );
}

/** Session chip row — pill radius 999, surface1 default, selected surface2+accent. */
export function OmChipRow(props: { children: ReactNode; style?: object }) {
  return <View style={{ flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, ...props.style }}>{props.children}</View>;
}

export function OmChip(props: {
  c: OmColors;
  active: boolean;
  label: string;
  onPress: () => void;
}) {
  const { c, active, label, onPress } = props;
  return (
    <Pressable
      onPress={onPress}
      style={{
        backgroundColor: active ? c.surface2 : c.surface1,
        borderColor: active ? c.accent : c.border,
        borderWidth: 1,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 4,
      }}
    >
      <Text style={{ color: active ? c.accent : c.foregroundMuted, fontSize: 11 }} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Section title line inside a card. */
export function OmSection(props: { c: OmColors; children: ReactNode }) {
  return (
    <Text style={{ color: props.c.foreground, fontSize: 12, fontWeight: "600" as const, marginTop: 8, marginBottom: 4 }}>
      {props.children}
    </Text>
  );
}

const OM_PICKER_SHOW = 4; // chips shown up front — flood control, the rest behind search

/** Shared chip label: '● name · Nt' / 'name · Nt'. */
export function omChipLabel(active: boolean, title: string | null, sessionId: string, topicFiles: number): string {
  return `${active ? "● " : ""}${title ? title.slice(0, 24) : sessionId.slice(0, 8)} · ${topicFiles}t`;
}

/** Shared session picker block: chips + search + flood control.
 *  Owns its search/expand state; renders nothing when sessions < 2. */
export function OmSessionPicker(props: {
  c: OmColors;
  sessions: { sessionId: string; label: string; active: boolean }[];
  selectedId: string | null | undefined;
  onPick: (sessionId: string | null) => void;
}) {
  const { c, sessions, selectedId, onPick } = props;
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  if (sessions.length < 2) return null;
  const q = search.trim().toLowerCase();
  const filtered = q
    ? sessions.filter((s) => s.sessionId.toLowerCase().includes(q) || s.label.toLowerCase().includes(q))
    : sessions;
  const chips = q || expanded ? filtered : filtered.slice(0, OM_PICKER_SHOW);
  const hidden = q || expanded ? 0 : filtered.length - chips.length;
  const moreStyle = { backgroundColor: c.surface1, borderColor: c.border, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 };
  return (
    <View style={{ marginBottom: 8, gap: 6 }}>
      <OmChipRow>
        {chips.map((s) => (
          <OmChip
            key={s.sessionId}
            c={c}
            active={s.sessionId === selectedId}
            onPress={() => onPick(s.sessionId === selectedId ? null : s.sessionId)}
            label={s.label}
          />
        ))}
        {hidden > 0 ? (
          <Pressable onPress={() => setExpanded(true)} style={moreStyle}>
            <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>+{hidden} more…</Text>
          </Pressable>
        ) : expanded ? (
          <Pressable onPress={() => setExpanded(false)} style={moreStyle}>
            <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>show less</Text>
          </Pressable>
        ) : null}
      </OmChipRow>
      <TextInput
        value={search}
        onChangeText={setSearch}
        placeholder="search session by name / id…"
        placeholderTextColor={c.foregroundMuted}
        style={{
          backgroundColor: c.surface1,
          borderColor: c.border,
          borderWidth: 1,
          borderRadius: OM_RADIUS_INPUT,
          paddingHorizontal: 8,
          paddingVertical: 4,
          color: c.foreground,
          fontSize: 12,
        }}
      />
    </View>
  );
}
