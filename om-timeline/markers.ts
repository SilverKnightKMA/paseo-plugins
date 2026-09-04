/**
 * Marker constants — MUST stay byte-compatible with ../MARKERS.md (vendored
 * copy of the pi-config contract). check-markers.py enforces the sync.
 * Detection is intentionally prefix-based and defensive: never assume payload
 * structure, never throw on malformed text.
 */

export const MARKER_VERSION = 1;

/** timeline card kinds emitted by the transformer (client-regex safe: kebab) */
export const CARD_KIND = "om-timeline-card" as const;

export type CardVariant = "om-event" | "zw-warning" | "auto-report" | "channel-nack";

export type CardData = {
  variant: CardVariant;
  text: string;
};

/** emitted-line prefixes (post blockquote-wrap where applicable) */
const PREFIXES: ReadonlyArray<[CardVariant, string]> = [
  ["om-event", "> om: "],
  ["zw-warning", "> zw ⚠ "],
  ["auto-report", "[auto-report] "],
  ["channel-nack", "[channel-nack] "],
];

/** Pure detection: trimmed first line must start with a documented prefix. */
export function detectMarker(rawText: string): CardData | null {
  const text = rawText.trim();
  if (!text) return null;
  for (const [variant, prefix] of PREFIXES) {
    if (text.startsWith(prefix)) {
      return { variant, text };
    }
  }
  return null;
}
