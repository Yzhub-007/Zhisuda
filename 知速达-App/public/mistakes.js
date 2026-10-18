import { $, api, error, mk } from "./shared.js";
let mistakes = [];
function render() {
  const filter = $("filter").value;
  const shown = mistakes.filter(r => filter === "all" || (filter === "mastered" ? r.state === "掌握" : r.state !== "掌握"));
  $("count").textContent = `待巩固 ${mistakes.filter(r => r.state !== "掌握").length} 题 · 已掌握 ${mistakes.filter(r => r.state === "掌握").length} 题 · 当前显示 ${shown.length} 题`;
  $("empty").hidden = shown.length > 0;
  $("mistakeList").replaceChildren(...shown.map(r => {
    const card = mk("article", "", "question-card" + (r.state === "掌握" ? "" : " is-wrong"));
    card.append(mk("p", `${r.course} / ${r.topic} / ${r.knowledgeName}`, "eyebrow"), mk("h2", r.question),
      mk("p", `${r.type === "简答" ? "自评：" : "最近状态："}${r.state} · 历史未掌握 ${r.wrongCount} 次`, "small"));
    const details = mk("details", "", "answer-details"); details.append(mk("summary", "展开上次回答、答案与原文依据"),
      mk("p", "上次回答：" + (r.responseText || r.response)), mk("p", "参考答案：" + (r.answerText || r.answer)), mk("p", r.explanation));
    const quote = mk("blockquote", "", "evidence"); quote.append(mk("div", `${r.sourceName} · ${r.ref}`, "evidence-label"), mk("p", r.quote)); details.append(quote);
    const retry = mk("a", "只重练这道题 →", "button primary"); retry.href = "/student.html?pack=" + encodeURIComponent(r.packId) + "&question=" + encodeURIComponent(r.questionId);
    card.append(details, retry); return card;
  }));
}
async function load() {
  error("error"); $("refresh").disabled = true;
  try { mistakes = (await api("/api/mistakes")).mistakes; render(); }
  catch (e) { error("error", e.message); }
  finally { $("refresh").disabled = false; }
}
$("filter").onchange = render; $("refresh").onclick = load;
window.addEventListener("pageshow", load);
