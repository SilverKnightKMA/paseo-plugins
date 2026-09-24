import { describe, expect, test } from "bun:test";
import { canAnswer, makeQuestionId, staleQuestions, validateAnswer, validateQuestion, type PendingQuestion } from "./ask";

describe("validate", () => {
  test("question/answer: accepts non-empty strings without trimming", () => {
    expect(validateQuestion("ask something").ok).toBe(true);
    expect(validateQuestion("   ").ok).toBe(false);
    expect(validateQuestion(5).ok).toBe(false);
    expect(validateAnswer("q-1", "answer").ok).toBe(true);
    expect(validateAnswer("", "answer").ok).toBe(false);
    expect(validateAnswer("q-1", " ").ok).toBe(false);
  });
});

describe("canAnswer", () => {
  test("only the question's parent can answer", () => {
    const p: PendingQuestion = { questionId: "q-1", childId: "c", parentId: "p1", createdAt: 0 };
    expect(canAnswer(p, "p1")).toBe(true);
    expect(canAnswer(p, "p2")).toBe(false);
    expect(canAnswer(p, undefined)).toBe(false);
  });
});

describe("makeQuestionId", () => {
  test("is unique", () => expect(makeQuestionId()).not.toBe(makeQuestionId()));
});

// ── pollRequired port (batch #294 P4): ask-stale sweeper selection ──
describe("staleQuestions (#294 P4)", () => {
  const MIN = 60_000;
  const q = (createdAt: number, lastNudgedAt?: number): PendingQuestion => ({
    questionId: `q-${createdAt}`, childId: "c", parentId: "p", createdAt, lastNudgedAt,
  });
  test("young question is not stale", () => {
    expect(staleQuestions([q(0)], 29 * MIN)).toEqual([]);
  });
  test("question past ASK_STALE_MS escalates", () => {
    expect(staleQuestions([q(0)], 31 * MIN).map((p) => p.questionId)).toEqual(["q-0"]);
  });
  test("just-nudged question waits the re-nudge window", () => {
    // created at 0, nudged at 31m, checked at 45m (< 31m + 60m) → silent
    expect(staleQuestions([q(0, 31 * MIN)], 45 * MIN)).toEqual([]);
  });
  test("nudged question re-escalates after ASK_RENUDGE_MS", () => {
    expect(staleQuestions([q(0, 31 * MIN)], 92 * MIN).map((p) => p.questionId)).toEqual(["q-0"]);
  });
  test("boundary exactly at threshold escalates", () => {
    expect(staleQuestions([q(0)], 30 * MIN).length).toBe(1);
  });
});
