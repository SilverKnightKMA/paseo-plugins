import React from "react";
import { Text, View } from "react-native";
import type { PluginTimelineItemProps } from "@getpaseo/plugin";
import type { CardData } from "./markers";
import { z } from "zod";

const CardDataSchema = z.object({
  variant: z.enum(["om-event", "zw-warning", "auto-report", "channel-nack"]),
  text: z.string(),
});

const VARIANT_LABEL: Record<CardData["variant"], string> = {
  "om-event": "OM",
  "zw-warning": "zombie-watchdog",
  "auto-report": "subagent",
  "channel-nack": "channel",
};

export function OmCard(props: PluginTimelineItemProps) {
  const parsed = CardDataSchema.safeParse(props.item.data);
  if (!parsed.success) {
    // contract rule 3: fall back to raw text, never hide the message
    return <Text>{JSON.stringify(props.item.data)}</Text>;
  }
  const { variant, text } = parsed.data;
  const danger = variant === "zw-warning" || variant === "channel-nack";
  const { theme } = props;
  return (
    <View
      style={{
        borderLeftWidth: 3,
        borderLeftColor: danger ? theme.colors.statusWarning : theme.colors.accent,
        backgroundColor: theme.colors.surface1,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        marginVertical: 4,
      }}
    >
      <Text style={{ fontSize: 11, color: danger ? theme.colors.statusWarning : theme.colors.accent }}>
        {VARIANT_LABEL[variant]}
      </Text>
      <Text style={{ fontSize: 13, color: theme.colors.foregroundMuted }}>{text}</Text>
    </View>
  );
}
