import { $, api, error, mk } from "./shared.js";
let history = [];
function render() {
  const pack = $("pack").value, shown = history.filter(h => !pack || h.packId === pack);
  $("empty").hidden = shown.length > 0;
  $("list").replaceChildren(...shown.map(h => {
    const card = mk("article", "", "question-card");
    const objective = h.objectiveTotal ? `客观题 ${h.objectiveCorrect}/${h.objectiveTotal} 正确` : "无客观题";
    const written = h.writtenTotal ? `简答 ${h.writtenAssessed}/${h.writtenTotal} 已自评` : "无简答题";
    card.append(mk("p", `${h.course} / ${h.topic}`, "eyebrow"), mk("h2", new Date(h.createdAt).toLocaleString("zh-CN")),
      mk("p", `${h.practiceMode === "study" ? "学习模式" : "模拟测试"} · ${h.total} 题 · ${objective} · ${written}`, "small"));
    const actions = mk("div", "", "actions");
    const result = mk("a", "查看本次作答与反馈", "button primary"); result.href = "/student.html?pack=" + encodeURIComponent(h.packId) + "&attempt=" + encodeURIComponent(h.id);
    const link = mk("a", "开始新一轮 →", "button secondary"); link.href = "/student.html?pack=" + encodeURIComponent(h.packId) + "&new=1"; actions.append(result, link); card.append(actions);
    return card;
  }));
}
(async () => {
  try {
    history = (await api("/api/history")).history;
    const seen = new Map(history.map(h => [h.packId, `${h.topic}`]));
    seen.forEach((name, id) => $("pack").append(new Option(name, id)));
    render();
  } catch (e) { error("error", e.message); }
})();
$("pack").onchange = render;
