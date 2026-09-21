/**
 * ask_parent / answer_child (#146 / plan step 11) — child-to-parent question
 * channel. Following the detached design, ask_parent does NOT block HTTP: it
 * returns immediately after forwarding the question. The answer reaches the
 * child as a [parent-answer] message (send wakes the child automatically).
 * The parent answers through answer_child on the main door.
 */

export const ASK_TOOL = {
  name: "ask_parent",
  description:
    "Ask the parent agent a question and CONTINUE working / end your turn after asking. " +
    "The question is delivered as [child-question]; the parent's [parent-answer] message will " +
    "arrive as a NEW message that wakes you. Do NOT wait idly — state clearly in your final " +
    "reply what you are blocked on.",
  inputSchema: {
    type: "object" as const,
    properties: {
      question: { type: "string", description: "Self-contained question for the parent (the parent sees nothing else)." },
    },
    required: ["question"],
    additionalProperties: false,
  },
};

export const ANSWER_TOOL = {
  name: "answer_child",
  description:
    "Answer a child's [child-question] (questionId comes in the envelope). " +
    "The answer is delivered to the child as [parent-answer] and wakes it.",
  inputSchema: {
    type: "object" as const,
    properties: {
      questionId: { type: "string" },
      answer: { type: "string" },
    },
    required: ["questionId", "answer"],
    additionalProperties: false,
  },
};

export interface PendingQuestion {
  questionId: string;
  childId: string;
  parentId: string;
  createdAt: number;
}

export function validateQuestion(q: unknown): { ok: true; question: string } | { ok: false; error: string } {
  if (typeof q !== "string" || q.trim().length === 0) return { ok: false, error: "invalid arguments: 'question' (non-empty string) is required" };
  return { ok: true, question: q };
}

export function validateAnswer(id: unknown, a: unknown): { ok: true; questionId: string; answer: string } | { ok: false; error: string } {
  if (typeof id !== "string" || id.length === 0) return { ok: false, error: "invalid arguments: 'questionId' (non-empty string) is required" };
  if (typeof a !== "string" || a.trim().length === 0) return { ok: false, error: "invalid arguments: 'answer' (non-empty string) is required" };
  return { ok: true, questionId: id, answer: a };
}

export function makeQuestionId(): string {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Only the question's PARENT may answer (prevents another child from injecting an answer). */
export function canAnswer(pending: PendingQuestion, callerAgentId: string | undefined): boolean {
  return pending.parentId === callerAgentId;
}
