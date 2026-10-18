import { $, api, error, mk } from "./shared.js";
let mistakes = [];
function render() {
  const filter = $("filter").value;
  const course = $("course").value, knowledge = $("knowledge").value, days = Number($("period").value);
  const shown = mistakes.filter(r => (filter === "all" || (filter === "mastered" ? r.state === "掌握" : r.state !== "掌握"))
    && (!course || r.course === course) && (!knowledge || r.knowledgeName === knowledge)
    && (!days || Date.parse(r.lastPracticedAt) >= Date.now() - days * 86400000));
  $("count").textContent = `待巩固 ${mistakes.filter(r => r.state !== "掌握").length} 题 · 已掌握 ${mistakes.filter(r => r.state === "掌握").length} 题 · 当前显示 ${shown.length} 题`;
  $("empty").hidden = shown.length > 0;
  // 按复习包汇总待巩固题，提供“整组重练”入口。
  const pending = new Map();
  shown.filter(r => r.state !== "掌握").forEach(r => { const e = pending.get(r.packId) || { topic: r.topic, course: r.course, ids: [] }; e.ids.push(r.questionId); pending.set(r.packId, e); });
  $("retryAll").replaceChildren(...[...pending].map(([packId, e]) => {
    const a = mk("a", `重练「${e.topic}」当前筛选的 ${e.ids.length} 道待巩固题 →`, "button primary");
    a.href = "/student.html?pack=" + encodeURIComponent(packId) + "&question=" + encodeURIComponent(e.ids.join(",")); return a;
  }));
  $("retryAll").hidden = pending.size === 0;
  $("mistakeList").replaceChildren(...shown.map(r => {
    const card = mk("article", "", "question-card" + (r.state === "掌握" ? "" : " is-wrong"));
    card.append(mk("p", `${r.course} / ${r.topic} / ${r.knowledgeName}`, "eyebrow"), mk("h2", r.question),
      mk("p", `${r.type === "简答" ? "自评：" : "客观答案核对："}${r.state} · 历史未掌握 ${r.wrongCount} 次 · 最近练习 ${new Date(r.lastPracticedAt).toLocaleString("zh-CN")}`, "small"));
    const details = mk("details", "", "answer-details"); details.append(mk("summary", "展开上次回答、答案与原文依据"),
      mk("p", "上次回答：" + (r.responseText || r.response)), mk("p", "参考答案：" + (r.answerText || r.answer)), mk("p", r.explanation));
    const quote = mk("blockquote", "", "evidence"); quote.append(mk("div", `${r.sourceName} · ${r.ref}`, "evidence-label"), mk("p", r.quote)); details.append(quote);
    const retry = mk("a", "只重练这道题 →", "button primary"); retry.href = "/student.html?pack=" + encodeURIComponent(r.packId) + "&question=" + encodeURIComponent(r.questionId);
    card.append(details, retry); return card;
  }));
}
async function load() {
  error("error"); $("refresh").disabled = true;
  try {
    mistakes = (await api("/api/mistakes")).mistakes;
    for (const [id, field, label] of [["course", "course", "全部课程"], ["knowledge", "knowledgeName", "全部知识点"]]) {
      const saved = $(id).value, values = [...new Set(mistakes.map(r => r[field]).filter(Boolean))];
      $(id).replaceChildren(new Option(label, ""), ...values.map(v => new Option(v, v)));
      if (values.includes(saved)) $(id).value = saved;
    }
    render();
  }
  catch (e) { error("error", e.message); }
  finally { $("refresh").disabled = false; }
}
$("filter").onchange = render; $("refresh").onclick = load;
["course", "knowledge", "period"].forEach(id => { $(id).onchange = render; });
$("resetFilters").onclick = () => { $("filter").value = "pending"; ["course", "knowledge", "period"].forEach(id => { $(id).value = ""; }); render(); };
window.addEventListener("pageshow", load);
