import test from "node:test";
import assert from "node:assert/strict";
import { createDraft, updateQuestion, publishDraft, studentPack, submitAttempt, saveFeedback, feedbackReport } from "../lib/workflow.js";
import { demoInput } from "../lib/demo.js";

function draft() { const input = demoInput(); return createDraft(input, input.pack, "demo"); }
function reviewed() {
  let d = draft();
  for (const q of d.questions) d = updateQuestion(d, q.id, { revision: d.revision, review: q.quoteFound ? "approved" : "rejected", evidenceConfirmed: q.quoteFound });
  return d;
}

test("自助练习：无需逐题审核，排除无原文题并如实标注未核对状态", () => {
  const d = draft(), p = publishDraft(d, d.revision, "self-study");
  assert.equal(p.reviewMode, "self-study");
  assert.equal(p.questions.length, 5); assert.equal(p.excludedCount, 1); assert.equal(p.unreviewedCount, 5);
  assert.ok(p.questions.every(q => q.review === "pending" && !q.evidenceConfirmed && q.quoteFound));
  assert.ok(d.questions.every(q => q.review === "pending"));
  const student = studentPack(p);
  assert.equal(student.unreviewedCount, 5); assert.equal(student.excludedCount, 1);
  assert.match(student.evidenceBoundary, /未经人工核对/);
  assert.ok(student.questions.every(q => !Object.hasOwn(q, "answer") && !Object.hasOwn(q, "quote")));
  const q = p.questions[0];
  assert.equal(submitAttempt(p, { questionIds: [q.id], answers: { [q.id]: "B" } }).results[0].correct, true);
  p.questions[0].explanation = "只改练习快照";
  assert.notEqual(d.questions[0].explanation, p.questions[0].explanation);
});

test("自助练习：过滤退回与不完整题，拒绝空包、过期修订和未知模式", () => {
  const d = draft();
  d.questions[0].review = "rejected";
  d.questions[1].answer = "";
  const p = publishDraft(d, d.revision, "self-study");
  assert.equal(p.questions.length, 3); assert.equal(p.excludedCount, 3);
  assert.throws(() => publishDraft(d, d.revision - 1, "self-study"), /已更新/);
  assert.throws(() => publishDraft(d, d.revision, "skip-all"), /模式/);
  d.questions.forEach(q => { q.quote = "原文不存在的内容"; });
  assert.throws(() => publishDraft(d, d.revision, "self-study"), /没有通过自动检查/);
});

test("审核：模型自称已核对也不能绕过原文与人工确认", () => {
  const d = draft(), good = d.questions[0], bad = d.questions.at(-1);
  assert.equal(bad.quoteFound, false);
  assert.throws(() => updateQuestion(d, good.id, { revision: d.revision, review: "approved" }), /人工确认/);
  assert.throws(() => updateQuestion(d, bad.id, { revision: d.revision, review: "approved", evidenceConfirmed: true }), /找不到引用/);
  assert.throws(() => publishDraft(d, d.revision), /逐题审核/);
});

test("审核：修改撤销通过状态；旧修订号与同请求修改通过均被阻止", () => {
  const before = reviewed(), id = before.questions[0].id;
  const changed = updateQuestion(before, id, { revision: before.revision, changes: { explanation: "新的解释需要教师再次确认。" } });
  assert.equal(changed.questions[0].review, "pending");
  assert.equal(changed.questions[0].evidenceConfirmed, false);
  assert.equal(before.questions[0].review, "approved");
  assert.throws(() => updateQuestion(changed, id, { revision: before.revision, review: "approved", evidenceConfirmed: true }), /已被其他页面更新/);
  assert.throws(() => updateQuestion(before, id, { revision: before.revision, changes: { answer: "A" }, review: "approved", evidenceConfirmed: true }), /先保存/);
});

test("发布：过滤退回题，发布后草稿修改不会改变历史快照", () => {
  const d = reviewed(), p = publishDraft(d, d.revision);
  assert.equal(p.questions.length, 5);
  assert.ok(p.questions.every(q => q.quoteFound && q.evidenceConfirmed));
  p.questions[0].explanation = "只修改快照副本";
  assert.notEqual(d.questions[0].explanation, p.questions[0].explanation);
  const student = studentPack(p);
  for (const q of student.questions) for (const key of ["answer", "explanation", "quote", "ref", "evidenceConfirmed"]) assert.equal(Object.hasOwn(q, key), false);
});

test("发布：空答案和不对应选项的选择题不能通过", () => {
  let d = draft(), id = d.questions[0].id;
  d = updateQuestion(d, id, { revision: d.revision, changes: { answer: "F" } });
  assert.throws(() => updateQuestion(d, id, { revision: d.revision, review: "approved", evidenceConfirmed: true }), /选择题/);
  d = updateQuestion(d, id, { revision: d.revision, changes: { answer: "" } });
  assert.throws(() => updateQuestion(d, id, { revision: d.revision, review: "approved", evidenceConfirmed: true }), /补全/);
});

test("作答：拒绝空题、重复题号、未知题号、漏答和伪造选项", () => {
  const p = publishDraft(reviewed(), 7), id = p.questions[0].id;
  for (const questionIds of [[], [id, id], ["不存在"]]) assert.throws(() => submitAttempt(p, { questionIds, answers: { [id]: "B" } }));
  assert.throws(() => submitAttempt(p, { questionIds: [id], answers: {} }), /全部/);
  assert.throws(() => submitAttempt(p, { questionIds: [id], answers: { [id]: "F" } }), /无效/);
});

test("反馈：服务端核对选择题；简答默认未自评且不能默认答对", () => {
  const d = reviewed(), p = publishDraft(d, d.revision);
  const selected = p.questions.filter(q => q.level === "标准");
  const answers = Object.fromEntries(selected.map(q => [q.id, q.type === "选择" ? "A" : "我只记得部分要点"]));
  const a = submitAttempt(p, { questionIds: selected.map(q => q.id), answers, correct: true });
  assert.equal(a.results[0].correct, false);
  assert.equal(a.results[1].correct, null);
  assert.equal(a.results[1].selfAssessment, null);
  assert.throws(() => saveFeedback(a, { difficulty: "合适", assessments: {} }), /自评/);
  const done = saveFeedback(a, { difficulty: "合适", assessments: { [selected[1].id]: "部分掌握" }, stuck: "简答解释不完整" });
  assert.throws(() => saveFeedback(done, { difficulty: "合适" }), /重复提交/);
  const report = feedbackReport(p, [done]);
  assert.equal(report.objectiveCount, 1);
  assert.equal(report.objectiveCorrect, 0);
  assert.equal(report.common.find(row => row.questionId === selected[1].id).count, 1);
  assert.match(report.note, /练习次数/);
  assert.match(report.note, /样本较小/);
});

test("反馈：未交自评的练习不进入已反馈统计", () => {
  const d = reviewed(), p = publishDraft(d, d.revision), q = p.questions[0];
  const a = submitAttempt(p, { questionIds: [q.id], answers: { [q.id]: "B" } });
  const report = feedbackReport(p, [a]);
  assert.equal(report.totalAttempts, 1);
  assert.equal(report.completed, 0);
  assert.equal(report.objectiveCount, 0);
});
