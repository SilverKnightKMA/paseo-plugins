// ui.tsx — SHARED UI kit cho om-status + om-panel (v1.0.2).
// Byte-identical copy tồn tại ở CẢ 2 thư mục plugin vì daemon checkout từng
// plugin một (git source:plugin/path) — không import chéo được lúc runtime.
// Repo-level check-shared-ui.py + bước CI ép 2 bản phải giống hệt nhau:
// sửa ở đây thì copy sang bản kia trong CÙNG commit, nếu không CI đỏ.
import React from "react";
import { Text, View, Pressable } from "react-native";
import type { ReactNode } from "react";

/** Màu theme mà kit này cần — structural, không kéo types của SDK vào. */
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

/** "42s ago / 5m ago / 3h ago / 2d ago" — chung cho mọi footer. */
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

/** Cách session đang hiển thị được resolve —thống nhất nhãn 2 panel. */
export const OM_VIA_LABEL: Record<string, string> = {
  explicit: "đang chọn",
  agent: "agent của pill",
  "workspace-active": "agent active",
  newest: "mới nhất",
};

export function omViaSuffix(via: string | null | undefined): string {
  if (!via || via === "explicit") return "";
  const label = OM_VIA_LABEL[via] ?? via;
  return ` (${label})`;
}

/** Card nền surface1 + rail trái 3px (mặc định accent, đổi màu qua prop). */
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

/** Header card chuẩn: title 13/600 + các dòng dim 11. */
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

/** Hàng chip session — pill 999, mặc định surface1, đang chọn surface2+accent. */
export function OmChipRow(props: { children: ReactNode; style?: object }) {
  return <View style={{ flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, ...props.style }} />;
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

/** Dòng title section trong card. */
export function OmSection(props: { c: OmColors; children: ReactNode }) {
  return (
    <Text style={{ color: props.c.foreground, fontSize: 12, fontWeight: "600" as const, marginTop: 8, marginBottom: 4 }}>
      {props.children}
    </Text>
  );
}
