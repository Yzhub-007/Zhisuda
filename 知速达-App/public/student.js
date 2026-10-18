import { $, api, error, mk } from "./shared.js";

let pack, attempt, level;
const answers = {}, assessments = {};
const id = new URLSearchParams(location.search).get("pack");

function renderLevels() {
  const levels = [...new Set(pack.questions.map(q => q.level))];
  $("levels").replaceChildren(...levels.map(item => {
    const button = mk("button", item, `button ${item === level ? "primary" : "secondary"}`);
    button.setAttribute("aria-pressed", String(item === level));
    button.onclick = () => { level = item; error("error"); renderLevels(); renderQuestions(); };
    return button;
  }));
}
function renderQuestions() {
  $("questions").replaceChildren(...pack.questions.filter(q => q.level === level).map((q, i) => {
    const card = mk("article", "", "question-card"); card.append(mk("div", `${String(i + 1).padStart(2, "0")} / ${q.type} / ${q.knowledgeName}`, "eyebrow"), mk("h2", q.question));
    if (q.type === "选择") {
      const fieldset = mk("fieldset"); fieldset.append(mk("legend", "选择一个答案", "small muted"));
      q.options.forEach((option, index) => {
        const label = mk("label", "", "option"), input = document.createElement("input");
        const letter = String.fromCharCode(65 + index); input.type = "radio"; input.name = q.id; input.value = letter; input.checked = answers[q.id] === letter;
        input.onchange = () => { answers[q.id] = letter; }; label.append(input, mk("b", letter), mk("span", option)); fieldset.append(label);
      }); card.append(fieldset);
    } else {
      const label = mk("label", "", "field"); label.append(mk("span", "你的回答"));
      const textarea = document.createElement("textarea"); textarea.rows = 4; textarea.maxLength = 5000; textarea.value = answers[q.id] || "";
      textarea.oninput = () => { answers[q.id] = textarea.value; }; label.append(textarea); card.append(label);
    }
    return card;
  }));
}
function renderResults() {
  const objective = attempt.results.filter(r => r.type === "选择");
  $("score").textContent = objective.length ? `客观题 ${objective.filter(r => r.correct).length}/${objective.length} 正确 · 简答题需自评` : "本次为简答练习，请对照要点自评";
  $("results").replaceChildren(...attempt.results.map((r, i) => {
    const card = mk("article", "", "question-card");
    card.append(mk("div", `${String(i + 1).padStart(2, "0")} / ${r.type === "选择" ? r.correct ? "答对了" : "需要再练" : "等待自评"}`, "eyebrow"), mk("h2", r.question), mk("p", `你的回答：${r.responseText || r.response}`, "muted"), mk("p", `参考答案：${r.answerText || r.answer}`), mk("p", r.explanation));
    const details = mk("details", "", "answer-details");
    details.append(mk("summary", "查看课程原文依据 ↗"));
    const evidence = mk("blockquote", "", "evidence"); evidence.append(mk("div", `${r.sourceName || "课程材料"} · ${r.ref}`, "evidence-label"), mk("p", r.quote)); details.append(evidence); card.append(details);
    if (r.type === "简答") {
      const label = mk("label", "", "field"); label.append(mk("span", "对照要点，你的掌握程度"));
      const select = document.createElement("select"); select.dataset.question = r.questionId; select.append(new Option("请选择自评", ""));
      ["掌握", "部分掌握", "未掌握"].forEach(v => select.append(new Option(v, v)));
      select.value = assessments[r.questionId] || ""; select.onchange = () => { assessments[r.questionId] = select.value; }; label.append(select); card.append(label);
    }
    return card;
  }));
}
$("submit").onclick = async () => {
  error("error"); $("submit").disabled = true;
  try {
    const questionIds = pack.questions.filter(q => q.level === level).map(q => q.id);
    attempt = (await api(`/api/publications/${id}/attempts`, "POST", { nickname: $("nickname").value, questionIds, answers })).attempt;
    $("practice").hidden = true; $("after").hidden = false; renderResults(); window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) { error("error", e.message); }
  finally { $("submit").disabled = false; }
};
$("feedback").onclick = async () => {
  error("error"); $("feedback").disabled = true;
  try {
    attempt = (await api(`/api/attempts/${attempt.id}/feedback`, "POST", { assessments, difficulty: $("difficulty").value, stuck: $("stuck").value })).attempt;
    $("feedbackStatus").textContent = "学习记录已保存，可在“我的复习包”中回顾本次练习。";
    $("after").querySelectorAll("select, textarea").forEach(node => { node.disabled = true; });
    const weak = attempt.results.filter(r => r.type === "选择" ? !r.correct : r.selfAssessment !== "掌握");
    const unique = [...new Set(weak.map(r => r.knowledgeName))];
    $("nextList").replaceChildren(...(unique.length ? unique.map(name => mk("li", `${name}：回看上方原文，合上材料后再次解释该概念。`)) : [mk("li", "本次暂未出现薄弱点；换一个时间，再独立提取一次。") ]));
    $("next").hidden = false;
  } catch (e) { error("error", e.message); $("feedback").disabled = false; }
};
$("again").onclick = () => location.reload();
async function init() {
  if (!id) throw new Error("请从“我的复习包”打开练习链接。");
  pack = (await api(`/api/publications/${encodeURIComponent(id)}/student`)).pack;
  $("title").textContent = pack.topic; $("subtitle").textContent = `${pack.course} · ${pack.questions.length} 道练习题 · ${pack.goal}`;
  $("reviewNotice").textContent = (pack.unreviewedCount ? `${pack.unreviewedCount} 道题未经人工核对。程序仅检查引用存在，答案与解析仍可能有误；有疑问时请回看原文。` : "本包题目已经人工核对；引用存在仍不等于结论正确，有疑问时请回看原文。") + (pack.excludedCount ? ` 已排除 ${pack.excludedCount} 道题（引用无法定位、字段不完整或已退回）。` : "");
  $("reviewNotice").hidden = false;
  $("demoNotice").hidden = pack.mode === "live"; level = pack.questions[0].level;
  $("practice").hidden = false; renderLevels(); renderQuestions();
}
init().catch(e => { $("title").textContent = "尚未打开复习包"; error("error", e.message); });
