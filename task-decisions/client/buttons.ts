/** #240 (P1): pure kind→buttons mapping (pinned by test; the card renders it). */
export type DecisionButton = "APPROVE" | "REJECT" | "CANCEL TASK" | "KEEP";

export function buttonsForKind(kind: "amend" | "cancel-proposal" | "appeal" | "note"): DecisionButton[] {
  if (kind === "cancel-proposal") return ["CANCEL TASK", "KEEP"];
  if (kind === "amend" || kind === "appeal") return ["APPROVE", "REJECT"];
  return []; // note: display-only, no buttons
}
