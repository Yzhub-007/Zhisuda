import { randomUUID } from "node:crypto";
import { checkEvidence, checkPack } from "./verify.js";
import { validateDocument, attachLocation, textDocument } from "./sources.js";

export const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const text = (v, max = 6000) => typeof v === "string" ? v.trim().slice(0, max) : "";
const levels = ["基础", "标准", "拓展"];
const fields = ["level", "type", "question", "options", "answer", "explanation", "knowledgeName", "ref", "quote"];

function cleanQuestion(q) {
  if (!q || typeof q !== "object" || Array.isArray(q)) throw fail("题目格式不正确。", 422);
  return {
    level: levels.includes(q.level) ? q.level : "基础",
    type: q.type === "选择" ? "选择" : "简答",
    question: text(q.question), answer: text(q.answer), explanation: text(q.explanation),
    knowledgeName: text(q.knowledgeName, 200), ref: text(q.ref, 300) || "待核对", quote: text(q.quote, 2000),
    options: q.type === "选择" && Array.isArray(q.options) ? q.options.slice(0, 6).map(o => text(o, 1000)) : [],
  };
}

export function validateQuestion(q) {
  if (!q.question || !q.answer || !q.explanation || !q.knowledgeName || !q.quote) throw fail("请补全题目、答案、解析、知识点和原文引用。", 422);
  if (q.type === "选择" && (q.options.length < 2 || q.options.some(o => !o) || !/^[A-F]$/.test(q.answer) || q.answer.charCodeAt(0) - 65 >= q.options.length)) {
    throw fail("选择题需有2—6个非空选项，答案须是对应的单个大写字母（如 B）。", 422);
  }
}

export function createDraft(input, raw, mode = "live") {
  if (!raw || !Array.isArray(raw.questions) || !raw.questions.length || raw.questions.length > 40) throw fail("模型未返回有效题目列表（需1—40题），请重试。", 502);
  const sourceDocument = validateDocument(input.sourceDocument, text(input.source, 60000));
  const source = sourceDocument.text;
  const checked = checkPack({
    knowledge: Array.isArray(raw.knowledge) ? raw.knowledge.slice(0, 20).map(k => ({
      name: text(k?.name, 200), explain: text(k?.explain), confusion: text(k?.confusion), quote: text(k?.quote, 2000), status: k?.status,
    })) : [],
    questions: raw.questions.map(q => ({ ...cleanQuestion(q), status: q.status })),
  }, source);
  const now = new Date().toISOString();
  return {
    id: randomUUID(), revision: 1, createdAt: now, updatedAt: now,
    course: text(input.course, 100) || "未命名课程", topic: text(input.topic, 100) || "未命名主题",
    goal: text(input.goal, 200) || "期末复习", source, sourceDocument, mode,
    knowledge: checked.knowledge,
    questions: checked.questions.map(q => ({ ...attachLocation(q, sourceDocument), id: randomUUID(), review: "pending", evidenceConfirmed: false, edited: false })),
  };
}

export function updateQuestion(draft, questionId, input) {
  if (input.revision !== draft.revision) throw fail("草稿已被其他页面更新，请刷新后重试。", 409);
  const q = draft.questions.find(q => q.id === questionId);
  if (!q) throw fail("题目不存在。", 404);
  const next = structuredClone(draft);
  const i = next.questions.findIndex(q => q.id === questionId);
  let item = next.questions[i];
  if (input.changes) {
    const changes = Object.fromEntries(fields.filter(k => Object.hasOwn(input.changes, k)).map(k => [k, input.changes[k]]));
    const cleaned = cleanQuestion({ ...q, ...changes });
    const changed = fields.some(k => JSON.stringify(cleaned[k]) !== JSON.stringify(q[k]));
    if (changed) {
      item = { ...item, ...cleaned, status: "需人工核验", note: "题目已修改，请重新确认引用与答案的关系。", review: "pending", evidenceConfirmed: false, edited: true };
    }
    item = checkEvidence(item, draft.source);
    // 保存修改后必须再次人工审核；同一请求不能绕过审核。
    if (changed && input.review === "approved") throw fail("修改后请先保存，再重新确认依据并审核。", 422);
  }
  if (input.review != null) {
    if (!["pending", "approved", "rejected"].includes(input.review)) throw fail("审核状态无效。");
    if (input.review === "approved") {
      validateQuestion(item);
      item = checkEvidence(item, draft.source);
      if (!item.quoteFound) throw fail("讲义中找不到引用，请修改引用或退回该题。", 422);
      if (input.evidenceConfirmed !== true) throw fail("请先人工确认：引用可以支持答案。", 422);
      item.evidenceConfirmed = true;
    } else item.evidenceConfirmed = false;
    item.review = input.review;
  }
  item = attachLocation(item, draft.sourceDocument || textDocument(draft.source));
  next.questions[i] = item;
  next.revision += 1;
  next.updatedAt = new Date().toISOString();
  return next;
}

export function publishDraft(draft, revision, reviewMode = "reviewed") {
  if (revision !== draft.revision) throw fail("草稿已更新，请刷新后再发布。", 409);
  if (!["reviewed", "self-study"].includes(reviewMode)) throw fail("请选择直接练习或人工核对模式。");
  const direct = reviewMode === "self-study";
  if (!direct && draft.questions.some(q => q.review === "pending")) throw fail("请逐题审核：通过或退回全部题目后再发布。", 422);
  // 自助练习不要求人工确认；字段不完整、已退回或引用无法定位的题目不进入练习。
  const questions = draft.questions.filter(q => {
    if (!direct) return q.review === "approved";
    if (q.review === "rejected" || !checkEvidence(q, draft.source).quoteFound) return false;
    try { validateQuestion(q); return true; }
    catch (err) { if (err.status === 422) return false; throw err; }
  });
  if (!questions.length) throw fail(direct ? "没有通过自动检查的题目。请在可选核对中补全题目和原文引用，或重新生成。" : "至少需要一道审核通过的题目。", 422);
  for (const q of questions) {
    validateQuestion(q);
    if (!checkEvidence(q, draft.source).quoteFound || (!direct && !q.evidenceConfirmed)) throw fail("存在未核验的题目，不能发布。", 422);
  }
  const unreviewedCount = questions.filter(q => q.review !== "approved" || !q.evidenceConfirmed).length;
  return {
    id: randomUUID(), draftId: draft.id, draftRevision: draft.revision,
    course: draft.course, topic: draft.topic, goal: draft.goal, mode: draft.mode,
    reviewMode, unreviewedCount, excludedCount: draft.questions.length - questions.length,
    requestedCount: draft.generation?.requestedCount ?? null, generatedCount: draft.questions.length,
    createdAt: new Date().toISOString(), questions: structuredClone(questions),
    sourceName: draft.sourceDocument?.name || "课程文字", sourceFingerprint: draft.sourceDocument?.fingerprint || null,
    evidenceBoundary: unreviewedCount ? `程序仅核对引用存在性；${unreviewedCount} 道题未经人工核对，答案和解析可能有误。` : "程序仅核对引用存在性；答案支持性已由使用者人工确认，仍不代表科学事实已被独立验证。",
  };
}

// 练习开始前不下发答案、解析和原文，保证先提取、再反馈。
export function studentPack(pack) {
  return {
    id: pack.id, course: pack.course, topic: pack.topic, goal: pack.goal, mode: pack.mode, createdAt: pack.createdAt,
    reviewMode: pack.reviewMode || "reviewed", unreviewedCount: pack.unreviewedCount || 0, excludedCount: pack.excludedCount || 0,
    evidenceBoundary: pack.evidenceBoundary,
    requestedCount: pack.requestedCount ?? null, generatedCount: pack.generatedCount ?? pack.questions.length,
    questions: pack.questions.map(({ id, question, options, level, type, knowledgeName }) => ({ id, question, options, level, type, knowledgeName })),
  };
}

export function submitAttempt(pack, input) {
  const practiceMode = input.practiceMode ?? "test";
  if (!["study", "test"].includes(practiceMode)) throw fail("请选择学习模式或模拟测试。");
  const ids = input.questionIds;
  if (!Array.isArray(ids) || !ids.length || ids.length > pack.questions.length || new Set(ids).size !== ids.length) throw fail("请选择有效的练习题目。");
  const answers = input.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw fail("作答格式不正确。");
  const results = ids.map(id => {
    const q = pack.questions.find(q => q.id === id);
    if (!q) throw fail("发布包中不存在该题。");
    const answer = text(answers[id], 5000);
    if (!answer) throw fail("请先完成全部选中题目，再查看答案。", 422);
    if (q.type === "选择" && !q.options[answer.charCodeAt(0) - 65]) throw fail("选择题选项无效。");
    if (q.type === "选择" && !/^[A-F]$/.test(answer)) throw fail("选择题答案无效。");
    return { questionId: id, question: q.question, type: q.type, level: q.level, knowledgeName: q.knowledgeName,
      response: answer, answer: q.answer, explanation: q.explanation, quote: q.quote, ref: q.ref, sourceName: pack.sourceName || "课程材料",
      responseText: q.type === "选择" ? `${answer} · ${q.options[answer.charCodeAt(0) - 65]}` : answer,
      answerText: q.type === "选择" ? `${q.answer} · ${q.options[q.answer.charCodeAt(0) - 65]}` : q.answer,
      correct: q.type === "选择" ? answer === q.answer : null, selfAssessment: null };
  });
  const attempt = { id: randomUUID(), packId: pack.id, practiceMode, createdAt: new Date().toISOString(), nickname: text(input.nickname, 20) || "匿名同学", results, feedback: null };
  return practiceMode === "study" ? saveAssessments(attempt, input) : attempt;
}

export function saveAssessments(attempt, input) {
  if (attempt.feedback) throw fail("本次自评已完成，请开始新一轮练习。", 409);
  const out = structuredClone(attempt);
  for (const [id, rating] of Object.entries(input.assessments || {})) {
    const row = out.results.find(r => r.questionId === id && r.type === "简答");
    if (!row || !["掌握", "部分掌握", "未掌握"].includes(rating)) throw fail("简答自评无效。", 422);
    row.selfAssessment = rating;
  }
  return out;
}

export function saveFeedback(attempt, input) {
  if (attempt.feedback) throw fail("这次练习已提交反馈，请勿重复提交。", 409);
  const out = structuredClone(attempt);
  for (const r of out.results.filter(r => r.type === "简答")) {
    const rating = input.assessments?.[r.questionId];
    if (!["掌握", "部分掌握", "未掌握"].includes(rating)) throw fail("请对每道简答题完成自评。", 422);
    r.selfAssessment = rating;
    // 自评与客观题的正确率分开统计。
  }
  if (!["太简单", "合适", "太难"].includes(input.difficulty)) throw fail("请选择难度感受。", 422);
  out.feedback = { difficulty: input.difficulty, stuck: text(input.stuck, 2000), submittedAt: new Date().toISOString() };
  return out;
}

export function feedbackReport(pack, attempts) {
  const completed = attempts.filter(a => a.packId === pack.id && a.feedback);
  const totalAttempts = attempts.filter(a => a.packId === pack.id).length;
  const objective = completed.flatMap(a => a.results.filter(r => r.type === "选择"));
  const common = pack.questions.map(q => {
    const rows = completed.flatMap(a => a.results.filter(r => r.questionId === q.id));
    const struggling = rows.filter(r => r.type === "选择" ? r.correct === false : r.selfAssessment !== "掌握");
    return { questionId: q.id, question: q.question, knowledge: q.knowledgeName, level: q.level, count: struggling.length, total: rows.length,
      measure: q.type === "选择" ? "客观题答错次数" : "自评未完全掌握次数", quote: q.quote, ref: q.ref,
      suggestion: struggling.length ? "回看课程原文，解释此概念后再尝试同类题。" : "继续按自己的时间安排间隔提取。" };
  }).filter(row => row.total).sort((a, b) => b.count / b.total - a.count / a.total);
  return { totalAttempts, completed: completed.length, objectiveCount: objective.length, objectiveCorrect: objective.filter(r => r.correct).length,
    note: "按练习次数统计，同一人可多次练习，不代表独立人数。简答题采用自评，不计入客观题正确率。" + (completed.length < 10 ? " 样本较小，仅供参考。" : ""),
    common, comments: completed.filter(a => a.feedback.stuck).map(a => ({ nickname: a.nickname, text: a.feedback.stuck })),
  };
}
