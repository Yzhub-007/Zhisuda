import { $, api, error, mk } from "./shared.js";
import { readSession, writeSession } from "./practice-storage.js";
import { matchesFilters } from "./filters.js";

const params = new URLSearchParams(location.search), id = params.get("pack"), onlyParam = params.get("question"), onlyIds = onlyParam ? new Set(onlyParam.split(",").filter(Boolean)) : null, only = onlyIds ? onlyParam : null;
const historyId = params.get("attempt");
const storageId = historyId ? id + ":attempt:" + historyId : only ? id + ":only:" + only : id;
let pack, attempt, level = "全部", qtype = "全部", knowledge = "全部", practiceMode = "study", ready = false, storageFailed = false;
let revealed = {}, checking = false;
let submissionId = crypto.randomUUID(), assessmentWrites = Promise.resolve();
let answers = {}, assessments = {};
const inScope = q => !onlyIds || onlyIds.has(q.id);
// 难度、题型、知识点三组筛选取交集；统计某一组的数量时，应用另外两组的当前选择。
const matches = (q, skip) => inScope(q) && matchesFilters(q, { level, type: qtype, knowledge }, skip);
const visibleQuestions = () => pack.questions.filter(q => matches(q));

function save() {
  if (!ready) return;
  try {
    writeSession(storageId, { answers, assessments, revealed, practiceMode, level, qtype, knowledge, attemptId: attempt?.id || null, submissionId,
      nickname: $("nickname").value, difficulty: $("difficulty").value, stuck: $("stuck").value, scroll: window.scrollY });
    storageFailed = false;
    $("saveStatus").textContent = "已自动保存到当前浏览器 · 可暂时退出后继续";
    $("saveStatus").className = "small good-text";
  } catch {
    storageFailed = true;
    $("saveStatus").textContent = "浏览器未能保存，请保持此页打开。已提交的记录仍在本机服务中。";
    $("saveStatus").className = "err small";
  }
}
function updateCount() {
  const shown = visibleQuestions(), answered = shown.filter(q => String(answers[q.id] || "").trim()).length;
  $("visibleCount").textContent = `当前显示 ${shown.length} / 整包 ${pack.questions.length} 题 · 已答 ${answered} / ${shown.length}` + (only ? (onlyIds?.size > 1 ? ` · 仅重练 ${onlyIds.size} 道待巩固题` : " · 仅重练这道错题") : "");
  $("answerProgress").max = shown.length; $("answerProgress").value = answered;
  $("submit").textContent = practiceMode === "study" ? `完成本轮 ${shown.length} 道题，保存学习记录 →` : `提交当前 ${shown.length} 道题，查看答案与依据 →`;
  $("submit").disabled = checking || !shown.length;
  $("practiceMode").disabled = checking || Object.keys(revealed).length > 0;
  $("modeHint").textContent = practiceMode === "study" ? "先独立回答，再逐题核对。核对后的答案锁定；完成本轮后统一存入历史与错题本。开始核对后，本轮不能切换模式。" : "完成当前显示的全部题目并统一提交后，才能查看答案与原文依据。";
}
function renderLevels() {
  const groups = [
    ["levels", "level", "难度", () => level, v => { level = v; }, q => q.level],
    ["types", "type", "题型", () => qtype, v => { qtype = v; }, q => q.type],
    ["knowledgeFilter", "knowledge", "知识点", () => knowledge, v => { knowledge = v; }, q => q.knowledgeName],
  ];
  for (const [id, skip, , get, set, field] of groups) {
    const options = ["全部", ...new Set(pack.questions.filter(inScope).map(field))];
    if (!options.includes(get())) set("全部");
    $(id).replaceChildren(...options.map(item => {
      const count = pack.questions.filter(q => matches(q, skip) && (item === "全部" || field(q) === item)).length;
      const button = mk("button", `${item} · ${count}`, `button ${item === get() ? "primary" : "secondary"}`);
      button.setAttribute("aria-pressed", String(item === get())); button.disabled = item !== get() && count === 0;
      button.onclick = () => { set(item); error("error"); renderLevels(); renderQuestions(); save(); };
      return button;
    }));
  }
  const active = [level, qtype, knowledge].some(v => v !== "全部");
  $("clearFilters").hidden = !active;
}
function renderQuestions() {
  $("questions").replaceChildren(...visibleQuestions().map(q => {
    const i = pack.questions.findIndex(item => item.id === q.id);
    const card = mk("article", "", "question-card"); card.dataset.question = q.id;
    card.append(mk("div", `${String(i + 1).padStart(2, "0")} / ${q.level} / ${q.type} / ${q.knowledgeName}`, "eyebrow"), mk("h2", q.question));
    if (q.type === "选择") {
      const fieldset = mk("fieldset"); fieldset.append(mk("legend", "选择一个答案", "small muted"));
      q.options.forEach((option, index) => {
        const label = mk("label", "", "option"), input = document.createElement("input");
        const letter = String.fromCharCode(65 + index); input.type = "radio"; input.name = q.id; input.value = letter; input.checked = answers[q.id] === letter;
        input.onchange = () => { answers[q.id] = letter; save(); updateCount(); }; label.append(input, mk("b", letter), mk("span", option)); fieldset.append(label);
      }); card.append(fieldset);
    } else {
      const label = mk("label", "", "field"); label.append(mk("span", "你的回答"));
      const textarea = document.createElement("textarea"); textarea.rows = 4; textarea.maxLength = 5000; textarea.value = answers[q.id] || "";
      textarea.oninput = () => { answers[q.id] = textarea.value; save(); updateCount(); }; label.append(textarea); card.append(label);
    }
    if (checking) card.querySelectorAll("input, textarea").forEach(input => { input.disabled = true; });
    if (practiceMode === "study") {
      const result = revealed[q.id];
      if (result) {
        card.querySelectorAll("input, textarea").forEach(input => { input.disabled = true; });
        const heading = mk("p", "", "eyebrow"); paintResult(card, heading, result, i);
        card.append(heading, mk("p", `参考答案：${result.answerText || result.answer}`), mk("p", result.explanation));
        appendEvidence(card, result);
        if (q.type === "简答") {
          const label = mk("label", "", "field"); label.append(mk("span", "对照要点自评（非自动判分）"));
          const select = document.createElement("select"); select.append(new Option("请选择自评", ""));
          ["掌握", "部分掌握", "未掌握"].forEach(v => select.append(new Option(v, v)));
          select.value = assessments[q.id] || "";
          select.onchange = () => { assessments[q.id] = select.value; paintResult(card, heading, result, i); save(); };
          label.append(select); card.append(label);
        }
      } else {
        const check = mk("button", "提交这道题，查看反馈", "button secondary"); check.disabled = checking;
        check.onclick = async () => {
          if (checking) return;
          error("error"); checking = true; check.disabled = true; updateCount();
          card.querySelectorAll("input, textarea").forEach(input => { input.disabled = true; });
          try {
            const { result } = await api(`/api/publications/${id}/check`, "POST", { questionIds: [q.id], answers: { [q.id]: answers[q.id] } });
            revealed[q.id] = result; save();
          } catch (e) { error("error", e.message); }
          finally { checking = false; renderQuestions(); }
        };
        card.append(check);
      }
    }
    return card;
  }));
  updateCount();
}
function resultState(r) {
  if (r.type === "选择") return r.correct ? "答对了" : `答错了 · ${attempt ? "已加入错题本" : "完成本轮后加入错题本"}`;
  const rating = assessments[r.questionId] || r.selfAssessment;
  return rating ? (rating === "掌握" ? "自评：掌握" : `自评：${rating} · ${attempt ? "已加入待巩固" : "完成本轮后加入待巩固"}`) : "简答题 · 等待自评";
}
function appendEvidence(card, r) {
  const details = mk("details", "", "answer-details"); details.append(mk("summary", "查看课程原文依据 ↗"));
  const evidence = mk("blockquote", "", "evidence"); evidence.append(mk("div", `${r.sourceName || "课程材料"} · ${r.ref}`, "evidence-label"), mk("p", r.quote)); details.append(evidence); card.append(details);
}
function paintResult(card, heading, r, i) {
  const rating = assessments[r.questionId] || r.selfAssessment;
  const wrong = r.type === "选择" ? r.correct === false : rating && rating !== "掌握";
  card.classList.toggle("is-wrong", Boolean(wrong));
  heading.textContent = `${String(i + 1).padStart(2, "0")} / ${resultState(r)}`;
}
function renderResults() {
  $("practice").hidden = true; $("after").hidden = false;
  const objective = attempt.results.filter(r => r.type === "选择");
  $("score").textContent = `${attempt.practiceMode === "study" ? "学习模式" : "模拟测试"} · ` + (objective.length ? `客观题 ${objective.filter(r => r.correct).length}/${objective.length} 正确 · 简答题对照要点自评` : "本次为简答练习，请对照要点自评");
  $("results").replaceChildren(...attempt.results.map((r, i) => {
    const card = mk("article", "", "question-card"), heading = mk("div", "", "eyebrow");
    paintResult(card, heading, r, i);
    card.append(heading, mk("h2", r.question), mk("p", `你的回答：${r.responseText || r.response}`, "your-answer"), mk("p", `参考答案：${r.answerText || r.answer}`), mk("p", r.explanation));
    appendEvidence(card, r);
    if (r.type === "简答") {
      const label = mk("label", "", "field"); label.append(mk("span", "对照要点，你的掌握程度（自评，非自动判分）"));
      const select = document.createElement("select"); select.dataset.question = r.questionId; select.append(new Option("请选择自评", ""));
      ["掌握", "部分掌握", "未掌握"].forEach(v => select.append(new Option(v, v)));
      select.value = assessments[r.questionId] || r.selfAssessment || ""; select.disabled = Boolean(attempt.feedback);
      select.onchange = () => {
        if (!select.value) return;
        const rating = select.value, attemptId = attempt.id;
        assessments[r.questionId] = rating; save(); paintResult(card, heading, r, i);
        $("feedbackStatus").textContent = "正在保存自评到错题本…";
        assessmentWrites = assessmentWrites.then(async () => {
          await api(`/api/attempts/${attemptId}/assessments`, "PATCH", { assessments: { [r.questionId]: rating } });
          $("feedbackStatus").textContent = "自评已保存，错题本已更新。";
        }).catch(e => { error("error", "自评尚未同步到错题本：" + e.message + "；可点击保存自评与卡点重试。"); });
      };
      label.append(select); card.append(label);
    }
    return card;
  }));
  $("difficulty").disabled = $("stuck").disabled = $("feedback").disabled = Boolean(attempt.feedback);
  if (attempt.feedback) {
    $("difficulty").value = attempt.feedback.difficulty; $("stuck").value = attempt.feedback.stuck;
    $("feedbackStatus").textContent = "本次学习记录已保存。";
  }
  $("again").hidden = false;
}
$("submit").onclick = async () => {
  error("error"); $("submit").disabled = true;
  try {
    const shown = visibleQuestions(), missing = shown.filter(q => !String(answers[q.id] || "").trim());
    if (missing.length) {
      $("questions").querySelector(`[data-question="${missing[0].id}"]`)?.scrollIntoView({ block: "center" });
      throw new Error(`还有 ${missing.length} 道题未作答，请完成当前显示的题目。已答内容已保留。`);
    }
    attempt = (await api(`/api/publications/${id}/attempts`, "POST", { nickname: $("nickname").value, practiceMode, assessments: Object.fromEntries(shown.filter(q => assessments[q.id]).map(q => [q.id, assessments[q.id]])), questionIds: shown.map(q => q.id), answers, submissionId })).attempt;
    save(); renderResults(); window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) { error("error", e.message); }
  finally { $("submit").disabled = false; }
};
$("feedback").onclick = async () => {
  error("error"); $("feedback").disabled = true;
  try {
    await assessmentWrites;
    attempt = (await api(`/api/attempts/${attempt.id}/feedback`, "POST", { assessments, difficulty: $("difficulty").value, stuck: $("stuck").value })).attempt;
    save(); renderResults(); $("feedbackStatus").textContent = "自评与卡点已保存，错题本已更新。";
  } catch (e) { error("error", e.message); $("feedback").disabled = false; }
};
$("again").onclick = () => {
  if (historyId) { location.href = `/student.html?pack=${encodeURIComponent(id)}&new=1`; return; }
  attempt = null; answers = {}; assessments = {}; revealed = {}; submissionId = crypto.randomUUID();
  $("difficulty").value = ""; $("stuck").value = ""; $("feedbackStatus").textContent = "";
  $("after").hidden = true; $("practice").hidden = false; renderLevels(); renderQuestions(); save(); window.scrollTo(0, 0);
};
$("clearFilters").onclick = () => { level = qtype = knowledge = "全部"; renderLevels(); renderQuestions(); save(); };
$("practiceMode").onchange = () => { practiceMode = $("practiceMode").value; renderQuestions(); save(); };
["nickname", "difficulty", "stuck"].forEach(name => $(name).addEventListener("input", save));
window.addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
$("home").onclick = event => { save(); if (storageFailed && !confirm("浏览器未能保存未提交答案，仍要退出吗？")) event.preventDefault(); };
window.addEventListener("beforeunload", event => { if (storageFailed) { event.preventDefault(); event.returnValue = ""; } });
async function init() {
  if (!id) throw new Error("请从“我的复习包”打开练习。");
  pack = (await api(`/api/publications/${encodeURIComponent(id)}/student`)).pack;
  if (onlyIds && ![...onlyIds].some(qid => pack.questions.some(q => q.id === qid))) throw new Error("这些题不在当前复习包中。");
  $("title").textContent = pack.topic; $("subtitle").textContent = `${pack.course} · ${pack.questions.length} 道可练题目 · ${pack.goal}`;
  $("reviewNotice").textContent = (pack.requestedCount ? `本次请求 ${pack.requestedCount} 题，模型返回 ${pack.generatedCount} 题，可练 ${pack.questions.length} 题。` : "") +
    (pack.excludedCount ? ` 已排除 ${pack.excludedCount} 道引用无法定位、字段不完整或已退回的题目。` : "") +
    (pack.requestedCount && pack.generatedCount < pack.requestedCount ? " 模型返回不足，未凑题补齐；可补充材料后再生成。" : "") +
    (pack.unreviewedCount ? ` ${pack.unreviewedCount} 道未经人工核对，引用存在不保证答案正确，有疑问请回看原文。` : " 题目已经人工核对，有疑问请回看原文。");
  $("reviewNotice").hidden = false; $("demoNotice").hidden = pack.mode === "live";
  const saved = params.get("new") === "1" ? null : readSession(storageId);
  if (params.has("new")) { params.delete("new"); window.history.replaceState(null, "", "/student.html?" + params); }
  if (saved) {
    const known = new Set(pack.questions.map(q => q.id));
    answers = Object.fromEntries(Object.entries(saved.answers || {}).filter(([key]) => known.has(key)));
    assessments = saved.assessments || {}; revealed = saved.revealed || {}; practiceMode = saved.practiceMode === "study" ? "study" : "test"; level = saved.level || "全部"; qtype = saved.qtype || "全部"; knowledge = saved.knowledge || "全部"; submissionId = saved.submissionId || submissionId;
    $("nickname").value = saved.nickname || ""; $("difficulty").value = saved.difficulty || ""; $("stuck").value = saved.stuck || "";
  }
  if (historyId || saved?.attemptId) {
    attempt = (await api("/api/attempts/" + encodeURIComponent(historyId || saved.attemptId))).attempt;
    if (attempt.packId !== id) throw new Error("练习记录与当前复习包不匹配。");
    if (historyId) assessments = {};
    attempt.results.forEach(r => { if (!assessments[r.questionId] && r.selfAssessment) assessments[r.questionId] = r.selfAssessment; });
    practiceMode = attempt.practiceMode || "test";
  }
  $("practiceMode").value = practiceMode;
  ready = true;
  if (attempt) renderResults();
  else { $("practice").hidden = false; renderLevels(); renderQuestions(); }
  save();
  if (saved?.scroll) requestAnimationFrame(() => window.scrollTo(0, saved.scroll));
}
init().catch(e => { $("title").textContent = "暂时无法打开练习"; error("error", e.message); });
