import test from "node:test";
import assert from "node:assert/strict";
import { mistakeBook, reviewPlan } from "../lib/mistakes.js";

const DAY = 86_400_000, t0 = Date.parse("2026-10-01T08:00:00Z");
const at = days => new Date(t0 + days * DAY).toISOString();
const choice = correct => ({ questionId: "q1", type: "选择", correct, selfAssessment: null });
const data = attempts => ({ publications: [{ id: "p", topic: "记忆", course: "心理学" }],
  attempts: attempts.map(([days, result]) => ({ packId: "p", createdAt: at(days), results: [result] })) });

test("复习规则：出错 1 天后到期，连续掌握依次拉长到 3、7 天，3 次后不再排期", () => {
  assert.equal(reviewPlan("未掌握", 0, at(0)).dueAt, at(1));
  assert.equal(reviewPlan("掌握", 1, at(0)).dueAt, at(3));
  assert.equal(reviewPlan("掌握", 2, at(0)).dueAt, at(7));
  assert.equal(reviewPlan("掌握", 3, at(0)).dueAt, null);
  assert.match(reviewPlan("部分掌握", 0, at(0)).reason, /部分掌握/);
});

test("错题本：到期判断依据最近一次作答，再次出错重置间隔", () => {
  let [row] = mistakeBook(data([[0, choice(false)]]), t0);
  assert.equal(row.due, false); assert.equal(row.dueAt, at(1));
  [row] = mistakeBook(data([[0, choice(false)]]), t0 + DAY);
  assert.equal(row.due, true);
  // 到期日当天的更早时刻也算到期（按日历日，不要求满 24 小时）。
  const morning = new Date(t0 + DAY); morning.setHours(0, 0, 1, 0);
  [row] = mistakeBook(data([[0, choice(false)]]), morning.getTime());
  assert.equal(row.due, true);

  [row] = mistakeBook(data([[0, choice(false)], [1, choice(true)]]), t0 + 2 * DAY);
  assert.equal(row.streak, 1); assert.equal(row.dueAt, at(4)); assert.equal(row.due, false);

  [row] = mistakeBook(data([[0, choice(false)], [1, choice(true)], [4, choice(false)]]), t0 + 5 * DAY);
  assert.equal(row.streak, 0); assert.equal(row.wrongCount, 2); assert.equal(row.due, true);

  [row] = mistakeBook(data([[0, choice(false)], [1, choice(true)], [4, choice(true)], [11, choice(true)]]), t0 + 100 * DAY);
  assert.equal(row.state, "掌握"); assert.equal(row.dueAt, null); assert.equal(row.due, false);
});

test("错题本：从未答错的题不进入复习队列，未自评的简答不排期", () => {
  assert.deepEqual(mistakeBook(data([[0, choice(true)]]), t0 + 30 * DAY), []);
  const written = { questionId: "q2", type: "简答", correct: null, selfAssessment: null };
  assert.deepEqual(mistakeBook(data([[0, written]]), t0 + 30 * DAY), []);
});
