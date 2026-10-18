import { $, api, error, mk } from "./shared.js";
import { readSession, writeSession } from "./practice-storage.js";

const params = new URLSearchParams(location.search), id = params.get("pack"), only = params.get("question");
const storageId = only ? id + ":only:" + only : id;
let pack, attempt, level = "全部", ready = false, storageFailed = false;
let submissionId = crypto.randomUUID(), assessmentWrites = Promise.resolve();
let answers = {}, assessments = {};
const visibleQuestions = () => pack.questions.filter(q => (!only || q.id === only) && (level === "全部" || q.level === level));

function save() {
  if (!ready) return;
  try {
    writeSession(storageId, { answers, assessments, level, attemptId: attempt?.id || null, submissionId,
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
  $("visibleCount").textContent = `当前显示 ${shown.length} / 整包 ${pack.questions.length} 题 · 已答 ${answered} / ${shown.length}` + (only ? " · 仅重练这道错题" : "");
  $("answerProgress").max = shown.length; $("answerProgress").value = answered;
  $("submit").textContent = `提交当前 ${shown.length} 道题，查看答案与依据 →`;
}
function renderLevels() {
  const levels = ["全部", ...new Set(pack.questions.filter(q => !only || q.id === only).map(q => q.level))];
  if (!levels.includes(level)) level = "全部";
  $("levels").replaceChildren(...levels.map(item => {
    const count = pack.questions.filter(q => (!only || q.id === only) && (item === "全部" || q.level === item)).length;
    const button = mk("button", `${item} · ${count}`, `button ${item === level ? "primary" : "secondary"}`);
    button.setAttribute("aria-pressed", String(item === level));
    button.onclick = () => { level = item; error("error"); renderLevels(); renderQuestions(); save(); };
    return button;
  }));
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
    return card;
  }));
  updateCount();
}
function resultState(r) {
  if (r.type === "选择") return r.correct ? "答对了" : "答错了 · 已加入错题本";
  const rating = assessments[r.questionId] || r.selfAssessment;
  return rating ? (rating === "掌握" ? "自评：掌握" : `自评：${rating} · 已加入待巩固`) : "简答题 · 等待自评";
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
  $("score").textContent = objective.length ? `客观题 ${objective.filter(r => r.correct).length}/${objective.length} 正确 · 简答题对照要点自评` : "本次为简答练习，请对照要点自评";
  $("results").replaceChildren(...attempt.results.map((r, i) => {
    const card = mk("article", "", "question-card"), heading = mk("div", "", "eyebrow");
    paintResult(card, heading, r, i);
    card.append(heading, mk("h2", r.question), mk("p", `你的回答：${r.responseText || r.response}`, "your-answer"), mk("p", `参考答案：${r.answerText || r.answer}`), mk("p", r.explanation));
    const details = mk("details", "", "answer-details"); details.append(mk("summary", "查看课程原文依据 ↗"));
    const evidence = mk("blockquote", "", "evidence"); evidence.append(mk("div", `${r.sourceName || "课程材料"} · ${r.ref}`, "evidence-label"), mk("p", r.quote)); details.append(evidence); card.append(details);
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
    attempt = (await api(`/api/publications/${id}/attempts`, "POST", { nickname: $("nickname").value, questionIds: shown.map(q => q.id), answers, submissionId })).attempt;
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
  attempt = null; answers = {}; assessments = {}; submissionId = crypto.randomUUID();
  $("difficulty").value = ""; $("stuck").value = ""; $("feedbackStatus").textContent = "";
  $("after").hidden = true; $("practice").hidden = false; renderLevels(); renderQuestions(); save(); window.scrollTo(0, 0);
};
["nickname", "difficulty", "stuck"].forEach(name => $(name).addEventListener("input", save));
window.addEventListener("pagehide", save);
document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
$("home").onclick = event => { save(); if (storageFailed && !confirm("浏览器未能保存未提交答案，仍要退出吗？")) event.preventDefault(); };
window.addEventListener("beforeunload", event => { if (storageFailed) { event.preventDefault(); event.returnValue = ""; } });
async function init() {
  if (!id) throw new Error("请从“我的复习包”打开练习。");
  pack = (await api(`/api/publications/${encodeURIComponent(id)}/student`)).pack;
  if (only && !pack.questions.some(q => q.id === only)) throw new Error("该题不在当前复习包中。");
  $("title").textContent = pack.topic; $("subtitle").textContent = `${pack.course} · ${pack.questions.length} 道可练题目 · ${pack.goal}`;
  $("reviewNotice").textContent = (pack.requestedCount ? `本次请求 ${pack.requestedCount} 题，模型返回 ${pack.generatedCount} 题，可练 ${pack.questions.length} 题。` : "") +
    (pack.excludedCount ? ` 已排除 ${pack.excludedCount} 道引用无法定位、字段不完整或已退回的题目。` : "") +
    (pack.requestedCount && pack.generatedCount < pack.requestedCount ? " 模型返回不足，未凑题补齐；可补充材料后再生成。" : "") +
    (pack.unreviewedCount ? ` ${pack.unreviewedCount} 道未经人工核对，引用存在不保证答案正确，有疑问请回看原文。` : " 题目已经人工核对，有疑问请回看原文。");
  $("reviewNotice").hidden = false; $("demoNotice").hidden = pack.mode === "live";
  const saved = readSession(storageId);
  if (saved) {
    const known = new Set(pack.questions.map(q => q.id));
    answers = Object.fromEntries(Object.entries(saved.answers || {}).filter(([key]) => known.has(key)));
    assessments = saved.assessments || {}; level = saved.level || "全部"; submissionId = saved.submissionId || submissionId;
    $("nickname").value = saved.nickname || ""; $("difficulty").value = saved.difficulty || ""; $("stuck").value = saved.stuck || "";
    if (saved.attemptId) {
      attempt = (await api("/api/attempts/" + encodeURIComponent(saved.attemptId))).attempt;
      if (attempt.packId !== id) throw new Error("练习记录与当前复习包不匹配。");
      attempt.results.forEach(r => { if (!assessments[r.questionId] && r.selfAssessment) assessments[r.questionId] = r.selfAssessment; });
    }
  }
  ready = true;
  if (attempt) renderResults();
  else { $("practice").hidden = false; renderLevels(); renderQuestions(); }
  save();
  if (saved?.scroll) requestAnimationFrame(() => window.scrollTo(0, saved.scroll));
}
init().catch(e => { $("title").textContent = "暂时无法打开练习"; error("error", e.message); });
